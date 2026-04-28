import { SocketIoHandlerProvider } from '../core/SocketIoHandler.js';
import { AppStoreDefault } from './AppStoreDefault.js';

class SocketIoDefault {
  static Handler = SocketIoHandlerProvider.create(AppStoreDefault);

  static Init(...args) {
    return this.Handler.Init(...args);
  }
}

export { SocketIoDefault };
