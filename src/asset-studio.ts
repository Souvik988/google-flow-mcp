/** A local-only control surface. Credentials remain in session memory, never in the page URL or local storage. */
export const assetStudioHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Flow Asset Studio</title>
  <style>
    :root { --ink:#17211d; --paper:#f5f1e8; --panel:#fffdf7; --line:#d4ccbb; --moss:#1b5946; --lime:#c8f169; --rust:#bf5435; --muted:#6b7168; }
    * { box-sizing:border-box; } body { margin:0; color:var(--ink); background:radial-gradient(circle at 82% -10%,#dceea6 0,transparent 31rem),var(--paper); font-family:Georgia,"Times New Roman",serif; }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.15; background-image:repeating-linear-gradient(0deg,transparent 0 3px,#263d3210 3px 4px); }
    .shell { max-width:1320px; margin:auto; padding:30px clamp(18px,4vw,58px) 64px; position:relative; }
    header { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; border-bottom:2px solid var(--ink); padding-bottom:20px; }
    .eyebrow { font:700 11px/1.1 "Trebuchet MS",sans-serif; letter-spacing:.15em; text-transform:uppercase; color:var(--moss); margin-bottom:9px; }
    h1 { font-size:clamp(2.4rem,6vw,5.5rem); letter-spacing:-.075em; line-height:.82; margin:0; font-weight:normal; } h1 em { color:var(--moss); }
    .tag { max-width:250px; font:600 12px/1.5 "Trebuchet MS",sans-serif; margin-top:5px; color:var(--muted); }
    .status { display:inline-flex; gap:8px; align-items:center; border:1px solid var(--ink); padding:8px 11px; font:700 11px "Trebuchet MS",sans-serif; text-transform:uppercase; letter-spacing:.08em; background:var(--panel); }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--rust); } .dot.ready { background:var(--moss); box-shadow:0 0 0 4px #c8f169; }
    main { display:grid; grid-template-columns:minmax(300px,.83fr) minmax(390px,1.45fr); gap:34px; margin-top:34px; }
    .rail { border-top:5px solid var(--moss); padding-top:17px; } h2 { margin:0 0 15px; font-size:1.55rem; letter-spacing:-.04em; font-weight:normal; }
    .note { font:13px/1.55 "Trebuchet MS",sans-serif; color:var(--muted); margin:0 0 19px; }
    label { display:block; font:700 10px/1.2 "Trebuchet MS",sans-serif; letter-spacing:.12em; text-transform:uppercase; margin:17px 0 7px; }
    textarea,select,input { width:100%; border:1px solid var(--ink); background:var(--panel); color:var(--ink); padding:12px; font:15px/1.4 Georgia,serif; border-radius:0; outline-offset:3px; }
    textarea { min-height:150px; resize:vertical; } .fields { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    button { appearance:none; cursor:pointer; border:1px solid var(--ink); background:var(--lime); color:var(--ink); padding:12px 16px; margin-top:19px; font:800 11px "Trebuchet MS",sans-serif; letter-spacing:.1em; text-transform:uppercase; box-shadow:4px 4px 0 var(--ink); transition:transform .12s,box-shadow .12s; } button:hover { transform:translate(2px,2px); box-shadow:2px 2px 0 var(--ink); } button.secondary { background:var(--panel); margin-top:10px; } button.small { margin:0; padding:7px 9px; box-shadow:none; font-size:9px; } button.danger { background:#f3b6a4; }
    .jobs-head { display:flex; justify-content:space-between; align-items:center; border-top:5px solid var(--ink); padding-top:17px; } .jobs-head button { margin:0; }
    #jobs { display:grid; gap:11px; } .empty { border:1px dashed var(--line); padding:32px; font:14px/1.6 "Trebuchet MS",sans-serif; color:var(--muted); text-align:center; }
    .job { background:var(--panel); border:1px solid var(--line); border-left:5px solid var(--moss); padding:15px; animation:rise .35s ease both; } .job.failed { border-left-color:var(--rust); } .job-top { display:flex; justify-content:space-between; gap:10px; align-items:start; } .job h3 { margin:0; font-size:16px; font-weight:normal; line-height:1.2; } .pill { font:800 10px "Trebuchet MS",sans-serif; letter-spacing:.08em; color:var(--moss); white-space:nowrap; } .failed .pill { color:var(--rust); }.meta { font:11px/1.5 "Trebuchet MS",sans-serif; color:var(--muted); margin:9px 0 0; }.actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }.actions button { margin:0; }
    dialog { border:2px solid var(--ink); background:var(--paper); padding:25px; width:min(440px,calc(100vw - 34px)); box-shadow:10px 10px 0 var(--moss); } dialog::backdrop { background:#17211d99; } dialog h2 { font-size:2rem; } .error { min-height:20px; margin-top:12px; font:12px/1.4 "Trebuchet MS",sans-serif; color:var(--rust); }.success { color:var(--moss); }
    @keyframes rise { from { opacity:0; transform:translateY(9px); } to { opacity:1; transform:none; } } @media (max-width:760px) { header,main { display:block; }.tag { margin:16px 0; }.status { margin-top:14px; }.rail { margin-bottom:35px; } }
  </style>
</head>
<body>
  <div class="shell">
    <header><div><div class="eyebrow">Local / authenticated / durable queue</div><h1>Flow <em>Asset</em><br />Studio</h1></div><div><div id="status" class="status"><span class="dot"></span><span>Locked</span></div><p class="tag">A local control room for the same Google Flow engine your MCP tools use.</p></div></header>
    <main>
      <section class="rail"><h2>Direct a generation</h2><p class="note">Use a clear shot brief. Jobs persist across page refreshes and are processed one at a time to protect the Flow browser session.</p><label for="prompt">Creative brief</label><textarea id="prompt" placeholder="A sunlit travel film shot of a vintage bicycle beside a coastal road. Slow lateral tracking movement, airy 35mm grain, no text."></textarea><div class="fields"><div><label for="model">Model</label><select id="model"><option value="gemini-omni-flash" selected>Gemini Omni Flash</option><option value="veo-3.1-fast">Veo 3.1 Fast</option><option value="veo-3.1-quality">Veo 3.1 Quality</option></select></div><div><label for="duration">Duration</label><select id="duration"><option value="4s">4 seconds</option><option value="6s">6 seconds</option><option value="8s">8 seconds</option><option value="10s" selected>10 seconds</option></select></div><div><label for="ratio">Frame</label><select id="ratio"><option value="16:9">Landscape 16:9</option><option value="9:16">Portrait 9:16</option><option value="1:1">Square 1:1</option></select></div></div><button id="submit">Create video job</button><button id="login" class="secondary">Open Flow sign-in</button><p id="form-message" class="error"></p></section>
      <section><div class="jobs-head"><div><h2>Generation ledger</h2><p class="note">Your recent Flow jobs. Refreshes automatically while a job is active.</p></div><button id="refresh" class="small">Refresh</button></div><div id="jobs"><div class="empty">Unlock the local engine to view jobs.</div></div></section>
    </main>
  </div>
  <dialog id="unlock"><h2>Unlock this local engine</h2><p class="note">Paste the FLOW_HTTP_TOKEN from this machine’s private .env file. It is kept only in this browser tab until you close it.</p><label for="token">Local API token</label><input id="token" type="password" autocomplete="off" placeholder="FLOW_HTTP_TOKEN" /><button id="unlock-button">Connect studio</button><p id="unlock-message" class="error"></p></dialog>
  <script>
    const $ = (id) => document.getElementById(id);
    const tokenKey = "flow-asset-studio-token";
    let token = sessionStorage.getItem(tokenKey) || "";
    const setStatus = (ready, text) => { $("status").innerHTML = '<span class="dot ' + (ready ? "ready" : "") + '"></span><span>' + text + '</span>'; };
    const api = async (path, options = {}) => {
      const response = await fetch('/v1' + path, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) } });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || 'Request failed (' + response.status + ')'); }
      return response;
    };
    const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[character]);
    const renderJobs = (jobs) => {
      const container = $('jobs');
      if (!jobs.length) { container.innerHTML = '<div class="empty">No jobs yet. Your next Flow video will appear here.</div>'; return; }
      container.innerHTML = jobs.map((job) => {
        const failed = /FAILED|AUTH_REQUIRED|UI_CHANGED|CANCELLED|RECOVERY_REQUIRED/.test(job.status);
        const finished = job.status === 'COMPLETED';
        return '<article class="job ' + (failed ? 'failed' : '') + '"><div class="job-top"><h3>' + escapeHtml(job.creativeBrief?.subject || job.compiledPrompt || 'Flow video job') + '</h3><span class="pill">' + escapeHtml(job.status) + '</span></div><p class="meta">' + escapeHtml(job.jobId) + ' · ' + new Date(job.createdAt).toLocaleString() + '</p>' + (job.error ? '<p class="meta">' + escapeHtml(job.error.message) + '</p>' : '') + '<div class="actions">' + (finished ? '<button class="small" data-download="' + job.jobId + '">Download asset</button>' : '') + (!finished && !failed ? '<button class="small danger" data-cancel="' + job.jobId + '">Cancel</button>' : '') + '</div></article>';
      }).join('');
    };
    const refresh = async () => { try { const jobs = await (await api('/jobs?limit=25')).json(); setStatus(true, 'Engine connected'); renderJobs(jobs); const active = jobs.some(job => !/COMPLETED|FAILED|CANCELLED|AUTH_REQUIRED|UI_CHANGED|RECOVERY_REQUIRED/.test(job.status)); if (active) setTimeout(refresh, 5000); } catch (error) { setStatus(false, 'Locked'); $('jobs').innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; } };
    const unlock = async () => { const candidate = $('token').value.trim(); if (!candidate) return; token = candidate; $('unlock-message').textContent = 'Checking local engine…'; try { await api('/health'); sessionStorage.setItem(tokenKey, token); $('unlock').close(); $('unlock-message').textContent = ''; await refresh(); } catch (error) { token = ''; $('unlock-message').textContent = error.message; } };
    $('unlock-button').addEventListener('click', unlock); $('token').addEventListener('keydown', event => { if (event.key === 'Enter') unlock(); });
    $('submit').addEventListener('click', async () => { const message = $('form-message'); const prompt = $('prompt').value.trim(); if (prompt.length < 3) { message.textContent = 'Add a creative brief first.'; return; } message.textContent = 'Creating durable job…'; try { await api('/jobs', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ prompt, model:$('model').value, duration:$('duration').value, aspectRatio:$('ratio').value, idempotencyKey:'studio-' + crypto.randomUUID() }) }); $('prompt').value = ''; message.textContent = 'Job created. It is now in the shared queue.'; message.className = 'error success'; refresh(); } catch (error) { message.textContent = error.message; message.className = 'error'; } });
    $('login').addEventListener('click', async () => { const message = $('form-message'); try { await api('/session/login', { method:'POST' }); message.textContent = 'A visible Flow sign-in window was opened. Complete sign-in there, then refresh this studio.'; message.className = 'error success'; } catch (error) { message.textContent = error.message; } });
    $('refresh').addEventListener('click', refresh); $('jobs').addEventListener('click', async (event) => { const button = event.target.closest('button'); if (!button) return; const jobId = button.dataset.cancel || button.dataset.download; try { if (button.dataset.cancel) { await api('/jobs/' + jobId + '/cancel', { method:'POST' }); refresh(); } else { const response = await api('/jobs/' + jobId + '/asset'); const url = URL.createObjectURL(await response.blob()); const anchor = Object.assign(document.createElement('a'), { href:url, download:jobId + '.mp4' }); anchor.click(); URL.revokeObjectURL(url); } } catch (error) { $('form-message').textContent = error.message; } });
    if (token) refresh(); else $('unlock').showModal();
  </script>
</body>
</html>`;
