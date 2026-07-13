import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';
import { TrmnlCameraPlatform } from './platform.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, TrmnlCameraPlatform);
};
