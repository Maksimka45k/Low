(function () {
  var errors = [];
  function remember(m) { errors.push(String(m)); }
  window.addEventListener('error', function (e) { remember(e.message || 'script error'); });
  window.addEventListener('unhandledrejection', function (e) { remember(e.reason && e.reason.message || e.reason); });
  function show(text) {
    var box = document.getElementById('loading');
    if (!box) return;
    box.classList.remove('hidden');
    while (box.firstChild) box.removeChild(box.firstChild);
    var p = document.createElement('div');
    p.className = 'fatal';
    p.textContent = text;
    box.appendChild(p);
  }
  setTimeout(function () {
    var box = document.getElementById('loading');
    var stuck = box && !box.classList.contains('hidden');
    var auth = document.getElementById('auth');
    var app = document.getElementById('app');
    var nothing = auth && app && auth.classList.contains('hidden') && app.classList.contains('hidden');
    if (!stuck && !nothing) return;
    var ua = navigator.userAgent;
    var msg = 'Не удалось запустить мессенджер. Обновите браузер или откройте сайт в Chrome.';
    if (!window.firebase) msg = 'Не загрузились скрипты Firebase. Проверьте интернет и отключите блокировщики.';
    if (errors.length) msg += '\n\n' + errors.slice(0, 3).join('\n');
    msg += '\n\n' + ua;
    show(msg);
  }, 10000);
})();
