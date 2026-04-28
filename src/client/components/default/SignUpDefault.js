import { SignUp } from '../core/SignUp.js';

class SignUpDefault {
  static async Init() {
    SignUp.Event['SignUpDefault'] = async (options) => {
      const { user } = options;
    };
  }
}

export { SignUpDefault };
