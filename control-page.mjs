// The control page served at / by service.mjs. Kept as a string module so
// `deno compile` embeds it without extra --include flags.
export const CONTROL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roon Streamer</title>
<style>
  :root {
    --bg: #f6f6f4; --card: #ffffff; --text: #1d1d1f; --muted: #6b6b70;
    --border: #dcdcd8; --accent: #2f6fde; --accent-text: #ffffff; --error: #c0362c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161618; --card: #222225; --text: #ececee; --muted: #9a9aa0;
      --border: #3a3a3f; --accent: #5b8ff0; --accent-text: #0d0d0f; --error: #f07167;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  label { display: block; font-weight: 600; margin-bottom: 8px; }
  input, select {
    width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
  }
  .field { margin-bottom: 16px; }
  .buttons { display: flex; gap: 10px; margin-top: 14px; }
  button {
    font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button:disabled { opacity: .5; cursor: default; }
  .status { margin-top: 20px; }
  .state { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .title { font-weight: 600; overflow-wrap: anywhere; }
  .error { color: var(--error); overflow-wrap: anywhere; }
  .roon { margin-top: 14px; font-size: .9rem; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Roon Streamer</h1>
  <form class="card" id="form">
    <div class="field">
      <label for="zone">Zone</label>
      <select id="zone" disabled><option value="">Waiting for Roon...</option></select>
    </div>
    <label for="url">YouTube (or other) URL</label>
    <input id="url" type="url" required placeholder="https://www.youtube.com/watch?v=..." autocomplete="off">
    <div class="buttons">
      <button class="primary" id="play" type="submit">Play</button>
      <button id="stop" type="button">Stop</button>
    </div>
    <div class="status" aria-live="polite">
      <div class="state" id="state">-</div>
      <div class="title" id="title"></div>
      <div class="error" id="error"></div>
    </div>
    <div class="roon" id="roon"></div>
  </form>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const LABELS = { idle: 'Idle', downloading: 'Downloading', preparing: 'Preparing', playing: 'Sent to Roon', error: 'Error' };

  let zoneList = '';

  // Rebuilds the options only when the zone list changes, so polling doesn't
  // close the dropdown while someone is choosing.
  function renderZones(roon) {
    const select = $('zone');
    const list = JSON.stringify(roon.zones || []);
    if (list != zoneList) {
      zoneList = list;
      select.replaceChildren();
      if (!roon.zone_id) select.add(new Option(roon.paired ? 'Choose a zone' : 'Waiting for Roon...', ''));
      for (const z of roon.zones || []) select.add(new Option(z.name, z.zone_id));
    }
    if (document.activeElement != select) {
      if (roon.zone_id && select.options[0]?.value == '') select.remove(0);
      select.value = roon.zone_id || '';
    }
    select.disabled = !roon.paired || !(roon.zones || []).length;
  }

  function render(s) {
    $('state').textContent = LABELS[s.state] || s.state;
    $('title').textContent = s.title || '';
    $('error').textContent = s.error || '';
    $('roon').textContent = s.roon.paired ? '' : 'Not paired: enable the extension in Roon > Settings > Extensions.';
    renderZones(s.roon);
    $('play').disabled = !s.roon.zone_id || s.state == 'downloading' || s.state == 'preparing';
  }

  async function call(method, path, body) {
    try {
      const res = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      render(data);
    } catch (err) {
      $('error').textContent = err.message;
    }
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    call('POST', '/api/play', { url: $('url').value.trim() });
  });
  $('stop').addEventListener('click', () => call('POST', '/api/stop'));
  $('zone').addEventListener('change', (e) => {
    if (e.target.value) call('POST', '/api/zone', { zone_id: e.target.value });
    e.target.blur();
  });

  call('GET', '/api/status');
  setInterval(() => call('GET', '/api/status'), 2000);
</script>
</body>
</html>
`;
