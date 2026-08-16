import type { Hono } from 'hono';

import { registerBlobRoutes } from './blobs';
import { registerCodeRoutes } from './codes';
import { registerDeviceRoutes } from './devices';
import { registerHealthRoutes } from './health';
import { registerPushRoutes } from './push';

export function registerRoutes(app: Hono): void {
  registerHealthRoutes(app);
  registerDeviceRoutes(app);
  registerPushRoutes(app);
  registerCodeRoutes(app);
  registerBlobRoutes(app);
}
