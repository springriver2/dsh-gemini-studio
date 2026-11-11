// Gemini 工作室 · Web 端
// 侧栏一个图标 → 主区一页：账号、生成、作品墙。
// 数据走同源 /gemini-studio-api/*（Host 插件注册的路由），不直连 8787。
window.__ModuleLoader__.load({
  id: 'dsh-gemini-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = '/gemini-studio-api';

    const CSS = `
.gs-page{height:100%;min-height:100%;overflow:auto;box-sizing:border-box;padding:26px 32px 72px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:14px/1.65 -apple-system,"PingFang SC",system-ui,sans-serif}
.gs-wrap{max-width:1000px;margin:0 auto}
.gs-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.gs-h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px}
.gs-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.gs-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  border-radius:12px;padding:16px 18px;margin-top:16px}
.gs-card h2{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);
  letter-spacing:.4px;text-transform:none}
.gs-acct{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.gs-acct:first-of-type{border-top:0}
.gs-name{font-weight:600}
.gs-mail{color:var(--dsw-alias-label-secondary);font-size:12px}
.gs-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gs-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;
  font-size:12px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.gs-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.gs-dot.ok{background:var(--dsw-alias-state-success-primary)}
.gs-dot.busy{background:var(--dsw-alias-state-warn-primary)}
.gs-dot.bad{background:var(--dsw-alias-state-error-primary)}
.gs-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  cursor:pointer;transition:border-color .15s,opacity .15s}
.gs-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.gs-btn:disabled{opacity:.45;cursor:default}
.gs-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l1)}
.gs-btn-danger:hover{border-color:var(--dsw-alias-state-error-primary)}
/* 深色主题下 brand-primary 是浅色，写死白字会变成"白底白字"看不见；
   用 bg-base 当正文字色，两种主题都自动对比 */
.gs-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-bg-base,#fff);font-weight:600}
.gs-btn-primary:hover:not(:disabled){opacity:.9;border-color:transparent}
.gs-input,.gs-area{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;
  padding:8px 10px;font:inherit;outline:none}
.gs-area{min-height:74px;resize:vertical}
.gs-input:focus,.gs-area:focus{border-color:var(--dsw-alias-brand-primary)}
.gs-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
.gs-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.gs-seg button{height:28px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer}
.gs-seg button.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.gs-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.gs-note.err{color:var(--dsw-alias-state-error-primary)}
.gs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:12px}
.gs-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.gs-item video{display:block;width:100%;aspect-ratio:9/16;background:#000;object-fit:cover}
.gs-item img{display:block;width:100%;height:auto;background:var(--dsw-alias-bg-layer-2);object-fit:cover}
.gs-item .meta{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gs-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:6px 0}
`;

    async function api(route, init) {
      const res = await fetch(API + route, init);
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text.slice(0, 200) };
      }
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return data;
    }

    function Icon({ size = 20, active }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 3.5, stroke: color, strokeWidth: 1.6 }),
        h('path', { d: 'M2.5 9.2h19', stroke: color, strokeWidth: 1.2, opacity: 0.45 }),
        h('path', { d: 'M14.6 11.6v5.2l4.3-2.6z', fill: color }),
        h('circle', { cx: 5.6, cy: 7.1, r: 0.9, fill: color, opacity: 0.8 }),
        h('circle', { cx: 8.4, cy: 7.1, r: 0.9, fill: color, opacity: 0.8 }),
      );
    }

    function ago(ms) {
      const d = Math.max(0, Date.now() - ms);
      if (d < 60000) return '刚刚';
      if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
      if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
      return Math.floor(d / 86400000) + ' 天前';
    }

    function fmtMB(bytes) {
      return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function Studio() {
      const [state, setState] = useState({ accounts: [], works: [], outDir: '', ok: true, error: null });
      const [prompt, setPrompt] = useState('');
      const [aspect, setAspect] = useState('9:16');
      const [kind, setKind] = useState('video');
      const [semi, setSemi] = useState(false);
      const [pick, setPick] = useState('');
      const [newName, setNewName] = useState('');
      const [notice, setNotice] = useState('');
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState(false);
      const [job, setJob] = useState(null);
      const [ttsInput, setTtsInput] = useState('');
      const [ttsBusy, setTtsBusy] = useState(false);
      const jobRef = useRef(null);

      const load = useCallback(async () => {
        try {
          const data = await api('/state');
          setState(data);
          setErr(data.ok ? '' : data.error || '桥不可用');
        } catch (e) {
          setErr(String(e.message || e));
        }
      }, []);

      useEffect(() => {
        load();
        const t = setInterval(load, 7000);
        return () => clearInterval(t);
      }, [load]);

      useEffect(() => {
        if (!job) return;
        const t = setInterval(async () => {
          try {
            const next = await api('/job/' + job.id);
            setJob(next);
            if (next.status !== 'running') {
              setBusy(false);
              setNotice(
                next.status === 'completed'
                  ? '完成：' + next.file + '（' + fmtMB(next.bytes || 0) + '，' + next.seconds + ' 秒）'
                  : '失败：' + next.error,
              );
              load();
            }
          } catch (e) {
            setErr(String(e.message || e));
          }
        }, 4000);
        return () => clearInterval(t);
      }, [job && job.id, load]);

      const generate = async () => {
        if (!prompt.trim()) return setErr('先写一句画面描述');
        setBusy(true);
        setErr('');
        setNotice('已提交，正在等 Gemini 出片…');
        try {
          const started = await api('/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: prompt.trim(), aspect, semi, kind, account: pick || undefined }),
          });
          const seed = { id: started.id, status: 'running', startedAt: Date.now(), prompt: prompt.trim() };
          setJob(seed);
        } catch (e) {
          setBusy(false);
          setErr(String(e.message || e));
        }
      };

      const addAccount = async () => {
        if (!newName.trim()) return setErr('先给账号起个名字');
        try {
          await api('/accounts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() }),
          });
          setNewName('');
          setNotice('已登记，Chrome 窗口已弹出，请在那个窗口里登录 Google');
          load();
        } catch (e) {
          setErr(String(e.message || e));
        }
      };

      const act = async (route, init, msg) => {
        try {
          await api(route, init);
          setNotice(msg);
          load();
        } catch (e) {
          setErr(String(e.message || e));
        }
      };

      const saveTtsKey = async () => {
        if (!ttsInput.trim()) return setErr('先粘贴 key');
        setTtsBusy(true);
        try {
          await api('/tts-key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: ttsInput.trim() }),
          });
          setTtsInput('');
          setNotice('配音 key 已保存');
          setErr('');
          load();
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setTtsBusy(false);
        }
      };

      const clearTtsKey = async () => {
        try {
          await api('/tts-key', { method: 'DELETE' });
          setNotice('配音 key 已清除');
          load();
        } catch (e) {
          setErr(String(e.message || e));
        }
      };

      const accounts = state.accounts || [];
      const works = state.works || [];

      return h(
        'div',
        { className: 'gs-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'gs-wrap' },
          h(
            'div',
            { className: 'gs-head' },
            h('h1', { className: 'gs-h1' }, 'Gemini 工作室'),
            h('span', { className: 'gs-sub' }, '本机已登录账号 · 网页版出片'),
            h('span', { className: 'gs-grow' }),
            h('button', { className: 'gs-btn', onClick: load }, '刷新'),
          ),
          (err || notice) &&
            h(
              'div',
              { className: 'gs-note' + (err ? ' err' : '') },
              err || notice,
            ),

          h(
            'div',
            { className: 'gs-card' },
            h('h2', null, '账号（' + accounts.length + '）'),
            accounts.length === 0
              ? h('div', { className: 'gs-empty' }, state.ok === false ? '桥没在运行：' + (state.error || '') : '还没有绑定账号')
              : accounts.map((a) =>
                  h(
                    'div',
                    { className: 'gs-acct', key: a.id },
                    h('span', {
                      className: 'gs-dot ' + (a.busy ? 'busy' : a.hardBlocked ? 'bad' : a.blocked ? 'bad' : 'ok'),
                    }),
                    h('span', { className: 'gs-name' }, a.name),
                    h('span', { className: 'gs-mail gs-grow' }, a.email || a.id),
                    h('span', { className: 'gs-chip' }, '今日 ' + (a.usedToday || 0) + '/' + (a.dailyCap || '?')),
                    h('span', { className: 'gs-chip' }, a.busy ? '生成中' : a.hardBlocked ? '需人工' : a.blocked ? '冷却中' : '可用'),
                    h('button', {
                      className: 'gs-btn',
                      onClick: () =>
                        act('/doctor', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ account: a.id }),
                        }, a.name + ' 体检完了'),
                      disabled: a.busy,
                    }, '体检'),
                    a.blocked &&
                      h('button', {
                        className: 'gs-btn',
                        onClick: () => act('/accounts/' + a.id + '/reset', { method: 'POST' }, a.name + ' 冷却已解除'),
                      }, '解冷却'),
                    h('button', {
                      className: 'gs-btn gs-btn-danger',
                      title: '从列表移除；登录态目录保留，重新添加同名账号还能接着用',
                      onClick: () => {
                        if (!window.confirm('移除账号「' + a.name + '」？\n\n只会从列表里去掉，Chrome 登录态目录保留，不会退出登录。')) return;
                        act('/accounts/' + a.id, { method: 'DELETE' }, a.name + ' 已从列表移除');
                      },
                    }, '移除'),
                  ),
                ),
            h(
              'div',
              { className: 'gs-tools' },
              h('input', {
                className: 'gs-input',
                style: { maxWidth: 220 },
                placeholder: '新账号名字，例如 jack2',
                value: newName,
                onChange: (e) => setNewName(e.target.value),
              }),
              h('button', { className: 'gs-btn', onClick: addAccount }, '添加账号'),
              h('span', { className: 'gs-sub' }, '会弹一个独立 Chrome，必须你本人登录'),
            ),
          ),

          h(
            'div',
            { className: 'gs-card' },
            h('h2', null, '生成'),
            h('textarea', {
              className: 'gs-area',
              placeholder: '画面和运镜，例如：雨后的青石板路，水洼倒影，镜头低角度前推',
              value: prompt,
              onChange: (e) => setPrompt(e.target.value),
            }),
            h(
              'div',
              { className: 'gs-tools' },
              h(
                'div',
                { className: 'gs-seg' },
                h('button', { className: kind === 'video' ? 'on' : '', onClick: () => setKind('video') }, '视频'),
                h('button', { className: kind === 'image' ? 'on' : '', onClick: () => setKind('image') }, '图片'),
              ),
              kind === 'video' &&
                h(
                  'div',
                  { className: 'gs-seg' },
                  ['9:16', '16:9'].map((r) =>
                    h('button', { key: r, className: aspect === r ? 'on' : '', onClick: () => setAspect(r) }, r),
                  ),
                ),
              kind === 'video' &&
                h(
                  'div',
                  { className: 'gs-seg' },
                  h('button', { className: semi ? '' : 'on', onClick: () => setSemi(false) }, '自动'),
                  h('button', { className: semi ? 'on' : '', onClick: () => setSemi(true) }, '半自动'),
                ),
              h(
                'select',
                {
                  className: 'gs-input',
                  style: { maxWidth: 180 },
                  value: pick,
                  onChange: (e) => setPick(e.target.value),
                },
                h('option', { value: '' }, '账号：自动轮换'),
                accounts.map((a) => h('option', { key: a.id, value: a.id }, a.name)),
              ),
              h('span', { className: 'gs-grow' }),
              h(
                'button',
                { className: 'gs-btn gs-btn-primary', onClick: generate, disabled: busy },
                busy ? '生成中…' : kind === 'image' ? '生成图片' : '生成视频',
              ),
            ),
            kind === 'video' &&
              semi &&
              h('div', { className: 'gs-note' }, '半自动：画幅和提示词会填好，停在发送前，你去 Chrome 窗口点发送。'),
            job &&
              job.status === 'running' &&
              h('div', { className: 'gs-note' }, '正在生成…已等 ' + Math.round((Date.now() - (job.startedAt || Date.now())) / 1000) + ' 秒'),
          ),

          h(
            'div',
            { className: 'gs-card' },
            h('h2', null, '配音（MiMo）'),
            h(
              'div',
              { className: 'gs-note' },
              state.tts && state.tts.configured
                ? '已配置' + (state.tts.source === 'studio' ? '' : '（来源：' + state.tts.source + '）')
                : '还没配置 key，配音功能不可用',
            ),
            h(
              'div',
              { className: 'gs-tools' },
              h('input', {
                className: 'gs-input',
                style: { maxWidth: 380 },
                type: 'password',
                placeholder: '粘贴 MiMo API key',
                value: ttsInput,
                onChange: (e) => setTtsInput(e.target.value),
              }),
              h('button', { className: 'gs-btn', onClick: saveTtsKey, disabled: ttsBusy || !ttsInput.trim() }, '保存'),
              state.tts && state.tts.configured && h('button', { className: 'gs-btn', onClick: clearTtsKey }, '清除'),
            ),
            h('div', { className: 'gs-note' }, '存在 ~/.dsh/gemini-studio/secrets.json（0600）；也支持环境变量 MIMO_API_KEY 和 mimocode.jsonc。'),
          ),

          h(
            'div',
            { className: 'gs-card' },
            h('h2', null, '作品（' + works.length + '）'),
            works.length === 0
              ? h('div', { className: 'gs-empty' }, '还没有成片')
              : h(
                  'div',
                  { className: 'gs-grid' },
                  works.slice(0, 12).map((w) =>
                    h(
                      'div',
                      { className: 'gs-item', key: w.name },
                      w.kind === 'image'
                        ? h('img', {
                            src: API + '/file/' + encodeURIComponent(w.name),
                            alt: w.name,
                            loading: 'lazy',
                          })
                        : h('video', {
                            src: API + '/file/' + encodeURIComponent(w.name),
                            preload: 'metadata',
                            controls: true,
                            muted: true,
                            playsInline: true,
                          }),
                      h('div', { className: 'meta', title: w.name }, w.name + ' · ' + fmtMB(w.bytes) + ' · ' + ago(w.mtime)),
                    ),
                  ),
                ),
            state.outDir && h('div', { className: 'gs-note' }, '成片目录：' + state.outDir),
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'gemini-studio', order: 3, label: 'Gemini 工作室' },
            Icon,
          ),
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'gemini-studio' }, Studio));
      },
    };
  },
});
