// node test/logic.test.js
'use strict';
const L = require('../js/logic.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}

// C3 遮罩
eq('mask 1', L.maskName('陳'), '陳');
eq('mask 2', L.maskName('陳安'), '陳O');
eq('mask 3', L.maskName('陳小安'), '陳O安');
eq('mask 4', L.maskName('歐陽娜娜'), '歐OO娜');
eq('mask trim', L.maskName('  王大明 '), '王O明');
eq('mask empty', L.maskName(''), '');
eq('mask emoji-safe', L.maskName('A𠀋B'), 'AOB');

// C9 密碼
eq('pin ok', L.pinProblem('2580'), null);
eq('pin ok2', L.pinProblem('1357'), null);
eq('pin same', L.pinProblem('0000'), 'WEAK_PIN');
eq('pin same9', L.pinProblem('9999'), 'WEAK_PIN');
eq('pin asc', L.pinProblem('1234'), 'WEAK_PIN');
eq('pin asc0', L.pinProblem('0123'), 'WEAK_PIN');
eq('pin asc6', L.pinProblem('6789'), 'WEAK_PIN');
eq('pin desc', L.pinProblem('8765'), 'WEAK_PIN');
eq('pin desc0', L.pinProblem('3210'), 'WEAK_PIN');
eq('pin 3 digits', L.pinProblem('123'), 'BAD_REQ');
eq('pin 5 digits', L.pinProblem('12345'), 'BAD_REQ');
eq('pin letters', L.pinProblem('12a4'), 'BAD_REQ');
eq('pin number type', L.pinProblem(2580), 'BAD_REQ');
eq('pin wrap not weak', L.pinProblem('8901'), null);

// C10 狀態
const T = '2026-09-29';
const P = o => Object.assign({ published: true, offOn: null, expiresOn: null, publishOn: '2026-09-01' }, o);
eq('on', L.status(P({}), T), { state: 'on', offDate: null, month: null });
eq('on expires today', L.status(P({ expiresOn: T }), T).state, 'on');
eq('off expired', L.status(P({ expiresOn: '2026-09-28' }), T), { state: 'off', offDate: '2026-09-28', month: '2026-09' });
eq('off expired prev month', L.status(P({ expiresOn: '2026-08-31' }), T).month, '2026-08');
eq('plan', L.status(P({ publishOn: '2026-09-30' }), T).state, 'plan');
eq('publish today on', L.status(P({ publishOn: T }), T).state, 'on');
eq('manual off', L.status(P({ published: false, offOn: '2026-09-05', expiresOn: '2026-12-31' }), T), { state: 'off', offDate: '2026-09-05', month: '2026-09' });
eq('manual off beats plan', L.status(P({ published: false, offOn: '2026-09-05', publishOn: '2026-10-01' }), T).state, 'off');
eq('manual off month uses offOn not expiry', L.status(P({ published: false, offOn: '2026-10-02', expiresOn: '2026-09-10' }), '2026-10-03').month, '2026-10');

// 日期
eq('addDays', L.addDays('2026-09-29', 3), '2026-10-02');
eq('addDays neg', L.addDays('2026-03-01', -1), '2026-02-28');
eq('today format', /^\d{4}-\d{2}-\d{2}$/.test(L.today()), true);
eq('today taipei', L.today(new Date('2026-09-29T17:00:00Z')), '2026-09-30');

// 單位
eq('normUnits order', L.normUnits(['cf', 'mzt', 'x']), ['mzt', 'cf']);
eq('isAll', L.isAllUnits(['cf', 'mala', 'mzt']), true);
eq('isAll no', L.isAllUnits(['cf', 'mala']), false);

// 排序
const list = [
  { id: 'a', pinned: false, publishOn: '2026-09-28' },
  { id: 'b', pinned: true, publishOn: '2026-09-01' },
  { id: 'c', pinned: false, publishOn: '2026-09-29' },
];
eq('sortBoard', list.slice().sort(L.sortBoard).map(x => x.id), ['b', 'c', 'a']);

// C11 附件
eq('type pdf', L.fileType('A.PDF'), 'pdf');
eq('type doc', L.fileType('x.doc'), 'docx');
eq('type xls', L.fileType('x.xls'), 'xlsx');
eq('type bad', L.fileType('x.png'), null);
eq('type none', L.fileType('noext'), null);
const MB = 1024 * 1024;
eq('files ok', L.checkFiles([{ name: 'a.pdf', size: 20 * MB }]), []);
eq('files too big', L.checkFiles([{ name: 'a.pdf', size: 20 * MB + 1 }]), [{ name: 'a.pdf', code: 'TOO_BIG' }]);
eq('files empty', L.checkFiles([{ name: 'a.pdf', size: 0 }]), [{ name: 'a.pdf', code: 'TOO_BIG' }]);
eq('files bad type', L.checkFiles([{ name: 'a.jpg', size: 10 }]), [{ name: 'a.jpg', code: 'BAD_TYPE' }]);
eq('files 6th', L.checkFiles([1, 2, 3, 4, 5, 6].map(i => ({ name: i + '.pdf', size: 1 }))), [{ name: '6.pdf', code: 'TOO_MANY' }]);

// 表單
const D = o => Object.assign({ title: '標題', units: ['mala'], publishOn: '2026-09-29', expiresOn: null, files: [] }, o);
eq('post ok', L.postProblem(D({})), null);
eq('post no title', L.postProblem(D({ title: '  ' })), '請填標題');
eq('post long title', L.postProblem(D({ title: 'x'.repeat(61) })), '標題最多 60 字');
eq('post no unit', L.postProblem(D({ units: [] })), '請選擇顯示單位');
eq('post bad unit only', L.postProblem(D({ units: ['xx'] })), '請選擇顯示單位');
eq('post exp before pub', L.postProblem(D({ expiresOn: '2026-09-28' })), '到期日不能早於上架日');
eq('post exp same day ok', L.postProblem(D({ expiresOn: '2026-09-29' })), null);

// 格式
eq('fmtMD', L.fmtMD('2026-09-05'), '9/5');
eq('fmtYM', L.fmtYM('2026-09'), '2026 年 9 月');
eq('fmtSize', L.fmtSize(1.5 * MB), '1.5 MB');

console.log(`logic: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
