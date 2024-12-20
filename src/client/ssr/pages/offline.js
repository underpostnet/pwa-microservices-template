import { htmls, loggerFactory } from '../common/SsrCore.js';
import { Alert } from '../common/Alert.js';
import { Translate } from '../common/Translate.js';
import { Worker } from '../common/Worker.js';
/*imports*/

const logger = loggerFactory({ url: location.toString() });

window.onload = () =>
  Worker.instance({
    render: async () => {
      window.ononline = async () => {
        location.href = location.pathname.split('/')[1] ? `/${location.pathname.split('/')[1].split('.')[0]}` : '/';
      };
      window.onoffline = async () => {
        htmls(`.page-render`, html`${await Alert.noInternet({ Translate })}`);
      };
      if (navigator.onLine && !location.hostname.match('localhost')) window.ononline();
      else window.onoffline();
    },
  });
