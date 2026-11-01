import { getCurrentWindow } from '@tauri-apps/api/window';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installFrontendLogBridge } from './utils/frontendLogBridge';
import ViewerWindow from './window/ViewerWindow';

import './styles.css';

installFrontendLogBridge();

const isViewerWindow = getCurrentWindow().label === 'viewer';

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode>{isViewerWindow ? <ViewerWindow /> : <App />}</React.StrictMode>);
