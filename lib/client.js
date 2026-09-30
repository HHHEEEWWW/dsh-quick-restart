/**
 * dsh-quick-restart — client half.
 *
 * One button, parked in the Windows caption strip next to the native window
 * controls. `shell.overlay` renders an absolute layer covering the whole frame,
 * so a child pinned to the top lands on the 40px titlebar strip; the native
 * min/max/close cluster owns the right edge and `env(titlebar-area-*)` reports
 * its geometry, so `100% - x - width` parks the button just left of it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-restart',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var API = '/dsh-quick-restart/api';

    var STYLE = [
      '@keyframes dsh-quick-restart-spin{to{transform:rotate(360deg)}}',
      '.dsh-quick-restart{position:absolute;top:0;z-index:30;-webkit-app-region:no-drag;',
      'right:calc(100% - env(titlebar-area-x,0px) - env(titlebar-area-width,calc(100% - 138px)));',
      'height:var(--dsh-windows-titlebar-height,40px);display:flex;align-items:center;padding-right:6px}',
      '.dsh-quick-restart>button{display:inline-flex;align-items:center;gap:6px;height:28px;min-width:104px;',
      'padding:0 12px;border:1px solid rgba(255,255,255,.16);border-radius:7px;background:#0b0b0e;color:#f7f7fa;',
      'font:inherit;font-size:12px;font-weight:600;letter-spacing:.02em;line-height:1;cursor:pointer;',
      'transition:background .15s,border-color .15s}',
      '.dsh-quick-restart>button:hover:not(:disabled){background:#18181d;border-color:rgba(255,255,255,.3)}',
      '.dsh-quick-restart>button:disabled{cursor:default;opacity:.85}',
      '.dsh-quick-restart>button[data-error]{border-color:rgba(229,72,77,.6);color:#ffb7b9}',
    ].join('');

    function api(path, init) {
      var options = Object.assign({ cache: 'no-store' }, init);
      options.headers = Object.assign({ 'x-dsh-quick-restart': '1' }, options.headers);
      return fetch(API + path, options);
    }

    function ensureStyle() {
      if (document.getElementById('dsh-quick-restart-style')) return;
      var style = document.createElement('style');
      style.id = 'dsh-quick-restart-style';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    function Icon(props) {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: props.spin ? { animation: 'dsh-quick-restart-spin 1s linear infinite' } : null,
        },
        React.createElement('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }),
        React.createElement('path', { d: 'M20.5 4.5v5h-5' }),
      );
    }

    function Restart() {
      var [state, setState] = React.useState({ busy: false, label: '重启', error: false });
      React.useEffect(ensureStyle, []);
      if (!document.documentElement.hasAttribute('data-windows-titlebar')) return null;

      async function click() {
        setState({ busy: true, label: '检查中…', error: false });
        var pid;
        try {
          var status = await (await api('/status')).json();
          pid = status.pid;
          var ask = status.tasksKnown && status.activeTasks;
          if (ask && !window.confirm('还有任务正在运行。现在重启会中断它们，继续吗？')) {
            return setState({ busy: false, label: '重启', error: false });
          }
          var result = await (await api('/restart', { method: 'POST' })).json();
          if (!result.ok) return setState({ busy: false, label: '重试', error: true });
        } catch (error) {
          /* The host dies mid-request when the restart lands — that is success. */
        }
        setState({ busy: true, label: '重启中…', error: false });
        var giveUp = Date.now() + 180000;
        var timer = setInterval(async function poll() {
          if (Date.now() > giveUp) return clearInterval(timer);
          try {
            var fresh = await (await api('/status')).json();
            if (fresh.ok && fresh.pid !== pid) {
              clearInterval(timer);
              window.location.reload();
            }
          } catch (error) {
            /* Absent while it comes back. */
          }
        }, 1000);
      }

      return React.createElement(
        'div',
        { className: 'dsh-quick-restart' },
        React.createElement(
          'button',
          {
            type: 'button',
            title: '一键重启 DSH（更新插件后使用）',
            disabled: state.busy,
            'data-error': state.error || undefined,
            onClick: click,
          },
          React.createElement(Icon, { spin: state.busy }),
          React.createElement('span', null, state.label),
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-quick-restart', order: 20, label: () => '重启' }, Restart),
      );
    }

    exports.name = 'dsh-quick-restart';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
