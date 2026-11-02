/* Radar à frente: lógica do painel.
   Lê radares.json, acompanha o GPS e escolhe o radar à frente na sua direção.
   ?demo=1 na URL simula uma viagem pela Av. Bezerra de Menezes (sentido oeste). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const LOOKAHEAD_M = 3000;   // radares considerados "no caminho"
  const SCOPE_M = 2000;       // raio do mini-mapa
  const CONE_DEG = 32;        // abertura do cone à frente
  const SENTIDO = { 'N-S': 180, 'S-N': 0, 'L-O': 270, 'O-L': 90 };
  const SENTIDO_TXT = { 'N-S': 'sentido norte → sul', 'S-N': 'sentido sul → norte', 'L-O': 'sentido leste → oeste', 'O-L': 'sentido oeste → leste' };

  const prefs = Object.assign({ alert: 500, tol: 0, sound: true },
    JSON.parse(localStorage.getItem('radar-prefs') || '{}'));
  const savePrefs = () => localStorage.setItem('radar-prefs', JSON.stringify(prefs));

  let radares = [];
  let watchId = null, wakeLock = null, audio = null;
  let last = null;             // última posição tratada {lat, lon, t}
  let speedKmh = null, heading = null;
  let targetId = null, targetMinDist = Infinity;
  const passed = new Map();    // id -> horário em que passou
  const alerted = new Set();   // ids já avisados na aproximação
  let lastBeep = 0;

  /* ---------- geometria ---------- */
  const R = 6371000, rad = Math.PI / 180;
  function dist(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  /* ---------- formatação ---------- */
  const fmtDist = (m) => m >= 1000 ? [(m / 1000).toFixed(1).replace('.', ','), 'km'] : [String(Math.round(m / 10) * 10), 'm'];
  const fonteTxt = (r) => r.fonte === 'AMC'
    ? (r.limite_oficial ? 'AMC' : 'AMC · limite pelo OpenStreetMap')
    : 'OpenStreetMap';

  /* ---------- dados ---------- */
  fetch('radares.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => {
    radares = d.radares;
    const amc = radares.filter((r) => r.fonte === 'AMC').length;
    $('dataInfo').textContent = `${radares.length} radares na base: ${amc} oficiais da AMC em Fortaleza e ${radares.length - amc} da região metropolitana pelo OpenStreetMap. Base montada em ${d.gerado.split('-').reverse().join('/')}.`;
    if (new URLSearchParams(location.search).has('demo')) startDemo();
  }).catch(() => {
    $('dataInfo').textContent = 'Não foi possível carregar a base de radares. Recarregue a página.';
    setState('error', 'Base de radares indisponível. Recarregue a página.');
  });

  /* ---------- GPS ---------- */
  function start() {
    unlockAudio();
    keepAwake();
    if (watchId !== null) { stop(); return; }
    if (!window.isSecureContext) return setState('error', 'Abra o painel por um endereço https:// para usar o GPS.');
    if (!('geolocation' in navigator)) return setState('error', 'Este navegador não informa a localização.');
    setState('running', 'Procurando sinal de GPS…');
    $('start').textContent = 'Parar';
    watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  function stop() {
    if (watchId !== null && watchId !== 'demo') navigator.geolocation.clearWatch(watchId);
    if (watchId === 'demo') clearInterval(demoTimer);
    watchId = null;
    $('start').textContent = 'Iniciar';
    $('gps').textContent = 'GPS desligado'; $('gps').dataset.ok = '0';
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    setState('idle', 'Painel pausado. Toque em Iniciar para continuar.');
    app.dataset.level = '';
  }
  function onErr(e) {
    const msg = e.code === 1 ? 'O acesso à localização foi negado. Libere nas configurações do navegador e toque em Iniciar.'
      : e.code === 3 ? 'O GPS está demorando. Continue tentando ao ar livre.' : 'Não foi possível ler o GPS.';
    if (e.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; $('start').textContent = 'Tentar de novo'; }
    setState(e.code === 1 ? 'error' : 'running', msg);
  }

  function onPos(p) {
    const c = p.coords, now = p.timestamp || Date.now();
    const pos = { lat: c.latitude, lon: c.longitude, t: now };
    // velocidade: a do GPS quando existe; senão, calculada entre leituras
    let v = (c.speed != null && !Number.isNaN(c.speed)) ? c.speed * 3.6 : null;
    if (v == null && last) {
      const dt = (now - last.t) / 1000;
      if (dt > 0.5) v = dist(last, pos) / dt * 3.6;
    }
    if (v != null) speedKmh = speedKmh == null ? v : speedKmh * 0.4 + v * 0.6;
    // direção: a do GPS em movimento; senão, entre leituras afastadas 12 m ou mais
    if (c.heading != null && !Number.isNaN(c.heading) && (speedKmh || 0) > 6) heading = c.heading;
    else if (last && dist(last, pos) >= 12) heading = bearing(last, pos);
    if (!last || dist(last, pos) >= 12 || c.heading != null) last = pos;
    const acc = Math.round(c.accuracy || 0);
    $('gps').textContent = acc ? `GPS ±${acc} m` : 'GPS ativo';
    $('gps').dataset.ok = acc && acc <= 30 ? '1' : '0';
    update(pos);
  }

  /* ---------- escolha do radar ---------- */
  function update(pos) {
    const now = Date.now();
    for (const [id, t] of passed) if (now - t > 120000) passed.delete(id);
    const moving = heading != null && (speedKmh || 0) > 7;
    const near = [];
    for (const r of radares) {
      if (Math.abs(r.lat - pos.lat) > 0.03 || Math.abs(r.lon - pos.lon) > 0.03) continue;
      const d = dist(pos, r);
      if (d > LOOKAHEAD_M) continue;
      const b = bearing(pos, r);
      let ahead = false;
      if (moving) {
        const inCone = angDiff(b, heading) <= (d < 120 ? 60 : CONE_DEG);
        const dirOk = r.sentido ? angDiff(heading, SENTIDO[r.sentido]) <= 75 : true;
        ahead = inCone && dirOk && !passed.has(r.id);
      }
      near.push({ r, d, b, ahead });
    }
    near.sort((a, b) => a.d - b.d);

    const list = moving ? near.filter((n) => n.ahead) : near;
    let tgt = list[0] || null;

    // passou pelo radar: chegou perto e começou a se afastar
    if (targetId) {
      const cur = near.find((n) => n.r.id === targetId);
      if (cur) {
        targetMinDist = Math.min(targetMinDist, cur.d);
        if (targetMinDist < 60 && cur.d > targetMinDist + 25) { passed.set(targetId, now); targetId = null; }
      }
    }
    if (tgt && tgt.r.id !== targetId) { targetId = tgt.r.id; targetMinDist = tgt.d; }
    if (!tgt) targetId = null;

    render(pos, tgt, list, near, moving);
  }

  /* ---------- tela ---------- */
  function render(pos, tgt, list, near, moving) {
    $('speed').textContent = speedKmh == null ? '—' : Math.round(speedKmh);
    const lim = tgt ? tgt.r.limite : null;
    $('signNum').textContent = lim ?? '?';
    $('sign').dataset.unknown = lim ? '0' : '1';
    $('signCap').textContent = lim ? 'limite no radar' : 'limite não informado';
    $('targetLabel').textContent = moving ? 'Próximo radar à frente' : 'Radar mais próximo';

    if (!tgt) {
      $('dist').textContent = '—'; $('distUnit').textContent = '';
      $('addr').textContent = moving ? 'Nenhum radar à frente nos próximos 3 km' : 'Nenhum radar num raio de 3 km';
      $('meta').textContent = 'O painel avisa quando um aparecer no caminho.';
      setMeter(0);
      app.dataset.level = speedKmh != null ? 'ok' : '';
      setVerdict(speedKmh != null ? 'Caminho livre de radares por enquanto.' : 'Procurando sinal de GPS…');
    } else {
      const [dv, du] = fmtDist(tgt.d);
      $('dist').textContent = dv; $('distUnit').textContent = du;
      $('addr').textContent = tgt.r.endereco;
      $('meta').textContent = [tgt.r.bairro, tgt.r.sentido && SENTIDO_TXT[tgt.r.sentido], fonteTxt(tgt.r)].filter(Boolean).join(' · ');
      setMeter(Math.max(0.02, Math.min(1, 1 - tgt.d / Math.max(prefs.alert, 1000))));
      judge(tgt);
    }
    renderList(list.slice(tgt ? 1 : 0, (tgt ? 1 : 0) + 4), moving);
    renderScope(pos, near, tgt);
  }

  function judge(tgt) {
    const lim = tgt.r.limite, v = speedKmh;
    const inWindow = tgt.d <= prefs.alert;
    const over = lim && v != null && v > lim + prefs.tol;
    let level = 'ok', text;
    if (over && inWindow) {
      level = 'bad'; text = `Reduza para ${lim} km/h. Você está ${Math.round(v - lim)} km/h acima.`;
      beep(true);
    } else if (inWindow) {
      level = 'warn';
      text = lim ? `Radar de ${lim} km/h em ${fmtDist(tgt.d).join(' ')}.` : `Radar em ${fmtDist(tgt.d).join(' ')}. Limite não informado: siga a placa.`;
      if (!alerted.has(tgt.r.id)) { alerted.add(tgt.r.id); beep(false); vibrate([150, 80, 150]); }
    } else if (over) {
      level = 'warn'; text = `Acima de ${lim} km/h. O radar está a ${fmtDist(tgt.d).join(' ')}.`;
    } else {
      text = v == null ? 'Aguardando a velocidade do GPS…' : 'Dentro do limite.';
    }
    app.dataset.level = level;
    setVerdict(text);
  }

  function renderList(items, moving) {
    $('next-title').textContent = moving ? 'Próximos no caminho' : 'Mais próximos';
    $('nextNote').textContent = 'até 3 km';
    const ol = $('next');
    if (!items.length) {
      ol.innerHTML = `<li class="empty">${radares.length ? 'Nenhum outro radar por perto.' : 'Nenhum radar listado ainda.'}</li>`;
      return;
    }
    ol.innerHTML = items.map(({ r, d }) => {
      const [dv, du] = fmtDist(d);
      const sub = [r.bairro, r.sentido && SENTIDO_TXT[r.sentido], r.fonte === 'OSM' ? 'OpenStreetMap' : null].filter(Boolean).join(' · ');
      return `<li><span class="d">${dv}<small>${du}</small></span><span class="w"><b>${esc(r.endereco)}</b><span>${esc(sub || '—')}</span></span>` +
        `<span class="lim${r.limite ? '' : ' unk'}" aria-label="${r.limite ? 'limite ' + r.limite + ' km/h' : 'limite não informado'}">${r.limite ?? '?'}</span></li>`;
    }).join('');
  }

  function renderScope(pos, near, tgt) {
    const s = 100 / SCOPE_M, h = heading || 0;
    let out = '';
    for (const m of [500, 1000, 2000]) out += `<circle class="ring" r="${m * s}"/><text class="ringlbl" x="4" y="${-m * s + 12}">${m >= 1000 ? m / 1000 + ' km' : m + ' m'}</text>`;
    for (const n of near) {
      if (n.d > SCOPE_M) continue;
      const a = (n.b - h) * rad, x = Math.sin(a) * n.d * s, y = -Math.cos(a) * n.d * s;
      const cls = tgt && n.r.id === tgt.r.id ? 'dot target' : n.ahead ? 'dot ahead' : 'dot';
      out += `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${cls === 'dot target' ? 5.5 : 3.2}"/>`;
    }
    out += '<path class="me" d="M0,-8 L6,6 L0,3 L-6,6 Z"/>';
    $('scope').innerHTML = out;
    $('scopeNote').textContent = heading != null ? 'raio de 2 km · topo = sua direção' : 'raio de 2 km · topo = norte';
  }

  function setMeter(f) { $('meterFill').style.width = (f * 100).toFixed(1) + '%'; $('meter').setAttribute('aria-valuenow', Math.round(f * 100)); }
  let lastVerdict = '';
  function setVerdict(t) { if (t !== lastVerdict) { $('verdict').textContent = t; lastVerdict = t; } }
  function setState(s, msg) { app.dataset.state = s; if (msg) setVerdict(msg); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- som, vibração, tela ligada ---------- */
  function unlockAudio() {
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  }
  function tone(freq, at, len) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.35, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(audio.destination); o.start(at); o.stop(at + len + 0.05);
  }
  function beep(urgent) {
    if (!prefs.sound || !audio) return;
    const now = Date.now();
    if (urgent && now - lastBeep < 1800) return;
    lastBeep = now;
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    if (urgent) { tone(1175, t, 0.12); tone(1175, t + 0.18, 0.12); vibrate([90, 60, 90]); }
    else { tone(880, t, 0.16); tone(1320, t + 0.2, 0.22); }
  }
  const vibrate = (p) => { if (navigator.vibrate) navigator.vibrate(p); };
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* sem suporte */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && watchId !== null) { wakeLock = null; keepAwake(); } });

  /* ---------- controles ---------- */
  $('start').addEventListener('click', start);
  const soundBtn = $('sound');
  const paintSound = () => { soundBtn.setAttribute('aria-pressed', String(prefs.sound)); soundBtn.textContent = prefs.sound ? 'Som ligado' : 'Som desligado'; };
  soundBtn.addEventListener('click', () => { prefs.sound = !prefs.sound; savePrefs(); paintSound(); unlockAudio(); if (prefs.sound) beep(false); });
  paintSound();
  function bindSeg(el, key) {
    const paint = () => el.querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.v) === prefs[key];
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
    });
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; prefs[key] = Number(b.dataset.v); savePrefs(); paint(); alerted.clear(); });
    el.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const bs = [...el.querySelectorAll('button')], i = bs.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; n.click(); n.focus(); e.preventDefault();
    });
    paint();
  }
  bindSeg($('alertSeg'), 'alert');
  bindSeg($('tolSeg'), 'tol');
  renderScope({ lat: 0, lon: 0 }, [], null);

  /* ---------- simulação (?demo=1) ---------- */
  let demoTimer = null;
  function startDemo() {
    // Av. Bezerra de Menezes, sentido leste → oeste, a partir de 700 m antes do primeiro radar
    const route = radares.filter((r) => /Bezerra de Menezes/.test(r.via) && r.sentido === 'L-O').sort((a, b) => b.lon - a.lon).map((r) => ({ lat: r.lat, lon: r.lon }));
    if (!route.length) return;
    route.unshift({ lat: route[0].lat + 0.0012, lon: route[0].lon + 0.0062 });
    let seg = 0, f = 0, t = 0;
    watchId = 'demo';
    $('start').textContent = 'Parar';
    setState('running', 'Simulação: Av. Bezerra de Menezes, sentido oeste.');
    demoTimer = setInterval(() => {
      t += 1;
      const kmh = 47 + 15 * Math.sin(t / 9);               // varia entre 32 e 62 km/h
      let step = kmh / 3.6;
      while (step > 0 && seg < route.length - 1) {
        const a = route[seg], b = route[seg + 1], L = dist(a, b), left = L * (1 - f);
        if (step < left) { f += step / L; step = 0; } else { step -= left; seg += 1; f = 0; }
      }
      if (seg >= route.length - 1) { seg = 0; f = 0; passed.clear(); alerted.clear(); last = null; heading = null; }
      const a = route[seg], b = route[Math.min(seg + 1, route.length - 1)];
      const p = { latitude: a.lat + (b.lat - a.lat) * f, longitude: a.lon + (b.lon - a.lon) * f, speed: kmh / 3.6, heading: bearing(a, b), accuracy: 5 };
      onPos({ coords: p, timestamp: Date.now() });
      $('gps').textContent = 'Simulação';
    }, 1000);
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
