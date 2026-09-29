# -*- coding: utf-8 -*-
"""按鈕與連結的覆蓋稽核（由 ~/mala-clock-in/e2e/clickmap.py 改寫給電子佈告欄）。

Eason 2026-09-03：「要測試全部每一個按鍵或連結是否可以正確且正常導入到目的地」。
每進到一個畫面就把當下的可點元素全部登記，點過的登記為已測，最後「登記過但沒被點過」的印出來，漏一顆就報失敗。

key 的規則（KEY_JS 與 SCAN_JS 共用同一段邏輯，不可分岔，否則會誤報漏測）：
  有 id → #id；
  data-* 列舉型（值只有幾種：分組、分頁、單位、狀態篩選、設定分頁）→ [attr=值]，每個值都要點到；
  data-* 逐筆型（每位同仁、每則公告、每個附件各一顆，功能相同）→ [attr]，點到任一顆即算；
  data-close → [data-close]；下拉與輸入 → tag+class；其他 → tag「前 24 字」。
"""

_KEY_LOGIC = """
  if (e.id) return '#' + e.id;
  const ENUM = ['pu', 'tab', 'unit', 'af', 'at'];
  const ITEM = ['pick', 'post', 'view', 'month', 'rx', 'cp', 're', 'off', 'pin', 'ed', 'rmf', 'rp', 'del', 'close'];
  const ds = e.dataset || {};
  for (const k of ENUM) if (ds[k] !== undefined) return '[data-' + k + '=' + ds[k] + ']';
  for (const k of ITEM) if (ds[k] !== undefined) return '[data-' + k + ']';
  const cls = (typeof e.className === 'string' && e.className.trim()) ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  if (e.tagName === 'SELECT' || e.tagName === 'INPUT') return e.tagName.toLowerCase() + cls;
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return e.tagName.toLowerCase() + '「' + txt + '」';
"""

KEY_JS = """
(sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const keyOf = (e) => {%s};
  return keyOf(e);
}
""" % _KEY_LOGIC

SCAN_JS = """
() => {
  const keyOf = (e) => {%s};
  const sel = 'button, a[href], input[type=checkbox], input[type=file], select';
  return [...document.querySelectorAll(sel)]
    .filter(e => e.offsetParent !== null || (e.type === 'file' && e.closest('.sheet')))
    .map(keyOf);
}
""" % _KEY_LOGIC

# 刻意不點、附理由（會列在報告裡，不算漏測）
SKIP = {}


class ClickMap:
    def __init__(self):
        self.seen = {}      # key -> 第一次看到它的畫面
        self.clicked = {}   # key -> 驗證了什麼

    def scan(self, page, screen):
        for k in page.evaluate(SCAN_JS):
            if k:
                self.seen.setdefault(k, screen)

    def key(self, page, sel):
        return page.evaluate(KEY_JS, sel)

    def mark(self, key, verified):
        if key:
            self.clicked[key] = verified

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        extra = {k: v for k, v in self.clicked.items() if k not in self.seen}
        return {'total': len(self.seen), 'clicked': len(self.clicked),
                'skipped': {k: SKIP[k] for k in self.seen if k in SKIP}, 'missed': missed, 'extra': extra}
