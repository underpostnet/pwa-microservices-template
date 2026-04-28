import { LogOut } from '../core/LogOut.js';
import { AppStoreDefault } from './AppStoreDefault.js';

class LogOutDefault {
  static async Init() {
    LogOut.Event['LogOutDefault'] = async (result = { user: { _id: '' } }) => {
      AppStoreDefault.Data.user.main.model.user = result.user;
    };
  }
}

export { LogOutDefault };
