"""Pure ComfyUI graphs for Klein and Boogu edit profiles."""


def build_workflow(source_name, mask_name, prompt, seed, geometry, config):
    g, c, workflow = geometry, config, {}
    family = c['family']
    if family not in ('klein', 'boogu'):
        raise ValueError('Unsupported generation family')

    def node(number, kind, **inputs):
        workflow[str(number)] = {'class_type': kind, 'inputs': inputs}
        return [str(number), 0]

    source = node(30, 'LoadImage', image=source_name)
    node(47, 'LoadImage', image=mask_name)
    # Comfy LoadImage exposes 1-alpha; uploaded alpha contains selection support.
    mask = node(48, 'InvertMask', mask=['47', 1])
    crop = node(50, 'ImageCrop', image=source, x=g['x'], y=g['y'], width=g['width'], height=g['height'])
    pixels = node(51, 'ImageScale', image=crop, upscale_method='lanczos', width=g['gen_width'], height=g['gen_height'], crop='disabled')
    mask_image = node(52, 'MaskToImage', mask=mask)
    mask_crop = node(53, 'ImageCrop', image=mask_image, x=g['x'], y=g['y'], width=g['width'], height=g['height'])
    mask_scaled = node(54, 'ImageScale', image=mask_crop, upscale_method='bilinear', width=g['gen_width'], height=g['gen_height'], crop='disabled')
    denoise_mask = node(55, 'ImageToMask', image=mask_scaled, channel='red')
    model = node(1, 'UNETLoader', unet_name=c['model'], weight_dtype=c.get('weight_dtype', 'default'))
    vae = node(3, 'VAELoader', vae_name=c['vae'])
    clip = node(2, 'CLIPLoader', clip_name=c['text_encoder'], type='flux2' if family == 'klein' else 'boogu', device=c.get('encoder_device', 'default'))
    if c.get('kv_cache'):
        model = node(5, 'FluxKVCache', model=model)
    if c.get('shift') is not None:
        model = node(6, 'ModelSamplingAuraFlow', model=model, shift=float(c['shift']))
    if family == 'boogu':
        node(7, 'TextEncodeBooguEdit', clip=clip, prompt=prompt, negative_prompt=c.get('negative_prompt', ''), vae=vae, **{'images.image_1': pixels})
        positive, negative = ['7', 0], ['7', 1]
    else:
        positive = node(7, 'CLIPTextEncode', clip=clip, text=prompt)
        negative = node(8, 'ConditioningZeroOut', conditioning=positive)
    encoded = node(56, 'VAEEncode', pixels=pixels, vae=vae)
    if c.get('mode', 'masked') == 'masked':
        latent = node(57, 'SetLatentNoiseMask', samples=encoded, mask=denoise_mask)
    elif c['mode'] == 'context':
        latent = node(57, 'EmptyFlux2LatentImage' if family == 'klein' else 'EmptyLatentImage', width=g['gen_width'], height=g['gen_height'], batch_size=1)
    else:
        raise ValueError('Unsupported generation mode')
    if family == 'klein':
        positive = node(58, 'ReferenceLatent', conditioning=positive, latent=encoded)
        negative = node(59, 'ReferenceLatent', conditioning=negative, latent=encoded)
        noise = node(28, 'RandomNoise', noise_seed=int(seed))
        guider = node(60, 'CFGGuider', model=model, positive=positive, negative=negative, cfg=float(c['cfg']))
        sampler = node(61, 'KSamplerSelect', sampler_name=c.get('sampler', 'euler'))
        sigmas = node(62, 'Flux2Scheduler', steps=int(c['steps']), width=g['gen_width'], height=g['gen_height'])
        latent = node(63, 'SamplerCustomAdvanced', noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=latent)
    else:
        latent = node(63, 'KSampler', model=model, seed=int(seed), steps=int(c['steps']), cfg=float(c['cfg']), sampler_name=c.get('sampler', 'euler'), scheduler=c.get('scheduler', 'simple'), positive=positive, negative=negative, latent_image=latent, denoise=float(c.get('denoise', 1)))
    decoded = node(64, 'VAEDecode', samples=latent, vae=vae)
    node(99, 'PreviewImage', images=decoded)
    return dict(workflow=workflow, output_node='99', output_kind='generation')
