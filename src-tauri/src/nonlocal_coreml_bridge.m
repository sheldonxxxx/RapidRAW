// Minimal macOS-only CoreML bridge for Nonlocal Bayer denoise.
 //
// This file is compiled only for macOS targets (see build.rs). It exposes a
// plain C ABI so the Rust backend never sends Objective-C messages itself:
// native compile of `.mlpackage` to `.mlmodelc`, single-`MLModel` load with
// all compute units and no low-precision GPU accumulation, live I/O contract
// validation, and synchronous single-tile prediction through MLMultiArray.
//
// Threading: prediction is synchronous on the caller's (denoise worker)
// thread. Cancellation lands on tile boundaries in Rust; an active CoreML
// prediction is not forcibly aborted.

#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define NLX_TILE 320
#define NLX_IN_CHANNELS 8
#define NLX_OUT_CHANNELS 4

typedef struct {
    // Retained Objective-C objects, held as void* because ARC forbids
    // object pointers in C structs (balanced with CFBridgingRelease).
    void *model;       // MLModel*
    void *compiledURL; // NSURL* of the compiled .mlmodelc
} NlxCoreMLModel;

static void nlx_set_error(char *buf, size_t cap, NSString *message) {
    if (buf == NULL || cap == 0) {
        return;
    }
    if (message == nil) {
        message = @"unknown CoreML error";
    }
    const char *utf8 = [message UTF8String];
    if (utf8 == NULL) {
        utf8 = "unrepresentable CoreML error";
    }
    strncpy(buf, utf8, cap - 1);
    buf[cap - 1] = '\0';
}

static bool nlx_check_multiarray(MLFeatureDescription *desc, NSString *expectedName,
                                 int64_t channels, NSString **failure) {
    if (desc == nil) {
        *failure = @"missing feature description";
        return false;
    }
    if (desc.type != MLFeatureTypeMultiArray) {
        *failure = @"feature is not a multiarray";
        return false;
    }
    MLMultiArrayConstraint *constraint = desc.multiArrayConstraint;
    if (constraint == nil) {
        *failure = @"multiarray has no constraint";
        return false;
    }
    if (constraint.dataType != MLMultiArrayDataTypeFloat32) {
        *failure = @"multiarray is not float32";
        return false;
    }
    NSArray<NSNumber *> *shape = constraint.shape;
    if (shape.count != 4 || [shape[0] longLongValue] != 1 ||
        [shape[1] longLongValue] != channels || [shape[2] longLongValue] != NLX_TILE ||
        [shape[3] longLongValue] != NLX_TILE) {
        *failure = @"multiarray shape mismatch";
        return false;
    }
    (void)expectedName;
    return true;
}

void *nlx_coreml_load(const char *package_path, char *err_buf, size_t err_cap) {
    @autoreleasepool {
        if (package_path == NULL) {
            nlx_set_error(err_buf, err_cap, @"package path is null");
            return NULL;
        }
        NSString *package = [NSString stringWithUTF8String:package_path];
        if (package == nil) {
            nlx_set_error(err_buf, err_cap, @"package path is not valid UTF-8");
            return NULL;
        }
        // The caller passes the validated packed.mlpackage directory itself
        // (the bundle manifest pins artifact = packed.mlpackage).
        NSURL *modelURL = [NSURL fileURLWithPath:package isDirectory:YES];
        NSError *error = nil;
        // Apple documents modelWithContentsOfURL:configuration:error: as the
        // load entry for a compiled .mlmodelc; compile natively first.
        NSURL *compiledURL = [MLModel compileModelAtURL:modelURL error:&error];
        if (compiledURL == nil) {
            nlx_set_error(err_buf, err_cap,
                          [NSString stringWithFormat:@"compileModelAtURL failed: %@",
                                                     error.localizedDescription]);
            return NULL;
        }
        MLModelConfiguration *config = [[MLModelConfiguration alloc] init];
        config.computeUnits = MLComputeUnitsAll;
        config.allowLowPrecisionAccumulationOnGPU = NO;
        MLModel *model = [MLModel modelWithContentsOfURL:compiledURL
                                           configuration:config
                                                   error:&error];
        if (model == nil) {
            NSString *detail = [NSString stringWithFormat:@"model load failed: %@",
                                                          error.localizedDescription];
            // Best-effort removal of the orphaned compilation, using the same
            // temporary-directory guard as the release path; the success path
            // is untouched.
            @try {
                NSString *tempDir = NSTemporaryDirectory();
                NSString *compiledPath = [compiledURL path];
                if (tempDir != nil && compiledPath != nil &&
                    [compiledPath hasPrefix:tempDir]) {
                    [[NSFileManager defaultManager] removeItemAtURL:compiledURL error:NULL];
                }
            } @catch (NSException *exception) {
                (void)exception;
            }
            nlx_set_error(err_buf, err_cap, detail);
            return NULL;
        }
        NlxCoreMLModel *handle = calloc(1, sizeof(NlxCoreMLModel));
        if (handle == NULL) {
            nlx_set_error(err_buf, err_cap, @"out of memory");
            return NULL;
        }
        handle->model = (void *)CFBridgingRetain(model);
        handle->compiledURL = (void *)CFBridgingRetain(compiledURL);
        return handle;
    }
}

int nlx_coreml_check_io(void *handle, char *err_buf, size_t err_cap) {
    @autoreleasepool {
        if (handle == NULL) {
            nlx_set_error(err_buf, err_cap, @"null model handle");
            return -1;
        }
        NlxCoreMLModel *h = (NlxCoreMLModel *)handle;
        MLModel *model = (__bridge MLModel *)(h->model);
        MLModelDescription *desc = [model modelDescription];
        if (desc.inputDescriptionsByName.count != 1 ||
            desc.outputDescriptionsByName.count != 1) {
            nlx_set_error(err_buf, err_cap, @"model must expose exactly one input and one output");
            return -1;
        }
        NSString *failure = nil;
        MLFeatureDescription *inDesc = desc.inputDescriptionsByName[@"raw_with_noise"];
        if (inDesc == nil || !nlx_check_multiarray(inDesc, @"raw_with_noise", NLX_IN_CHANNELS, &failure)) {
            nlx_set_error(err_buf, err_cap,
                          [NSString stringWithFormat:@"input contract mismatch: %@", failure]);
            return -1;
        }
        MLFeatureDescription *outDesc = desc.outputDescriptionsByName[@"denoised_raw"];
        if (outDesc == nil || !nlx_check_multiarray(outDesc, @"denoised_raw", NLX_OUT_CHANNELS, &failure)) {
            nlx_set_error(err_buf, err_cap,
                          [NSString stringWithFormat:@"output contract mismatch: %@", failure]);
            return -1;
        }
        return 0;
    }
}

int nlx_coreml_predict(void *handle, const float *input, float *output, char *err_buf,
                       size_t err_cap) {
    @autoreleasepool {
        if (handle == NULL || input == NULL || output == NULL) {
            nlx_set_error(err_buf, err_cap, @"null prediction argument");
            return -1;
        }
        NlxCoreMLModel *h = (NlxCoreMLModel *)handle;
        MLModel *model = (__bridge MLModel *)(h->model);
        NSError *error = nil;
        MLMultiArray *inArray =
            [[MLMultiArray alloc] initWithShape:@[ @1, @NLX_IN_CHANNELS, @NLX_TILE, @NLX_TILE ]
                                       dataType:MLMultiArrayDataTypeFloat32
                                          error:&error];
        if (inArray == nil) {
            nlx_set_error(err_buf, err_cap,
                          [NSString stringWithFormat:@"input multiarray failed: %@",
                                                     error.localizedDescription]);
            return -1;
        }
        memcpy([inArray dataPointer], input,
               (size_t)1 * NLX_IN_CHANNELS * NLX_TILE * NLX_TILE * sizeof(float));
        MLFeatureValue *inValue = [MLFeatureValue featureValueWithMultiArray:inArray];
        MLDictionaryFeatureProvider *provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:@{@"raw_with_noise" : inValue}
                                                              error:&error];
        if (provider == nil) {
            nlx_set_error(err_buf, err_cap,
                          [NSString stringWithFormat:@"feature provider failed: %@",
                                                     error.localizedDescription]);
            return -1;
        }
        id<MLFeatureProvider> result = [model predictionFromFeatures:provider error:&error];
        if (result == nil) {
            nlx_set_error(err_buf, err_cap,
                          [NSString stringWithFormat:@"prediction failed: %@",
                                                     error.localizedDescription]);
            return -1;
        }
        MLMultiArray *outArray = [[result featureValueForName:@"denoised_raw"] multiArrayValue];
        if (outArray == nil) {
            nlx_set_error(err_buf, err_cap, @"missing denoised_raw output");
            return -1;
        }
        if (outArray.dataType != MLMultiArrayDataTypeFloat32 ||
            outArray.count != (NSUInteger)NLX_OUT_CHANNELS * NLX_TILE * NLX_TILE) {
            nlx_set_error(err_buf, err_cap, @"output multiarray shape/dtype mismatch");
            return -1;
        }
        // Copy with the reported strides; the output is not assumed
        // contiguous. MLMultiArray strides are element counts.
        NSArray<NSNumber *> *strides = outArray.strides;
        NSArray<NSNumber *> *shape = outArray.shape;
        if (strides.count != 4 || shape.count != 4 || [shape[0] longLongValue] != 1 ||
            [shape[1] longLongValue] != NLX_OUT_CHANNELS ||
            [shape[2] longLongValue] != NLX_TILE || [shape[3] longLongValue] != NLX_TILE) {
            nlx_set_error(err_buf, err_cap, @"output multiarray shape mismatch");
            return -1;
        }
        const float *src = (const float *)[outArray dataPointer];
        int64_t s0 = [strides[0] longLongValue];
        int64_t s1 = [strides[1] longLongValue];
        int64_t s2 = [strides[2] longLongValue];
        int64_t s3 = [strides[3] longLongValue];
        for (int64_t c = 0; c < NLX_OUT_CHANNELS; c++) {
            for (int64_t y = 0; y < NLX_TILE; y++) {
                for (int64_t x = 0; x < NLX_TILE; x++) {
                    output[(c * NLX_TILE + y) * NLX_TILE + x] =
                        src[c * s1 + y * s2 + x * s3 + 0 * s0];
                }
            }
        }
        return 0;
    }
}

void nlx_coreml_free(void *handle) {
    @autoreleasepool {
        if (handle == NULL) {
            return;
        }
        NlxCoreMLModel *h = (NlxCoreMLModel *)handle;
        // Best-effort removal of the natively compiled model, but only when
        // CoreML placed it under the system temporary directory; never
        // delete anything else.
        @try {
            NSURL *compiled = (__bridge_transfer NSURL *)(h->compiledURL);
            h->compiledURL = NULL;
            NSString *tempDir = NSTemporaryDirectory();
            NSString *compiledPath = [compiled path];
            if (tempDir != nil && compiledPath != nil &&
                [compiledPath hasPrefix:tempDir]) {
                [[NSFileManager defaultManager] removeItemAtURL:compiled error:NULL];
            }
        } @catch (NSException *exception) {
            (void)exception;
        }
        if (h->model != NULL) {
            CFBridgingRelease(h->model);
            h->model = NULL;
        }
        free(h);
    }
}
