/* 設定。GAS_URL 在 T10 部署後填入；MODE 可用網址 ?mode=local 暫時切換成假資料。 */
'use strict';
var CFG = (function () {
  var c = {
    VERSION: '0.3.8',
    GAS_URL: 'https://script.google.com/macros/s/AKfycbzQXAnMnrYGoUEMDzr6XbtsuIDYyGWbGLcFW1xVDpa64NcBrMzI9GaVKJhIlC-WxnGK5g/exec',
    MODE: 'cloud',
    TIMEOUT: { _default: 30000, uploadFile: 120000, adminData: 40000, savePost: 40000, syncClock: 60000, receipts: 90000 }
  };
  try {
    var m = new URLSearchParams(location.search).get('mode');
    if (m === 'local' || m === 'cloud') c.MODE = m;
  } catch (e) {}
  if (c.MODE === 'cloud' && !c.GAS_URL) c.MODE = 'local';   // 尚未部署後端前，一律走假資料
  return c;
})();
