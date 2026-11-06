// Explicit offline operator check. Never imported by API startup; never calls WeChat.
import { WechatCredentialStore } from '../apps/api/dist/wechat-credentials.js';
let credentialsLoaded = false,
  code = 'CREDENTIALS_NOT_CONFIGURED';
try {
  const directory = process.env.WECHAT_PAY_CREDENTIALS_DIR;
  if (directory) {
    const appId = process.env.WECHAT_PAY_APP_ID,
      merchantId = process.env.WECHAT_PAY_MCH_ID,
      notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL;
    if (!appId || appId !== process.env.WECHAT_APP_ID || !merchantId || !notifyUrl)
      throw Error('BINDING');
    const store = new WechatCredentialStore(directory, { appId, merchantId, notifyUrl });
    await store.reload();
    store.current();
    credentialsLoaded = true;
    code = 'CREDENTIALS_VALID_OFFLINE';
  }
} catch {
  code = 'CREDENTIALS_INVALID';
}
console.log(
  JSON.stringify({ code, credentialsLoaded, canStartPayment: false, networkChecked: false }),
);
if (!credentialsLoaded) process.exitCode = 1;
