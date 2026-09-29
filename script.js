(function(){

  /* =========================================================
     KONFIGURASI BACKEND
     ========================================================= */
  const API_BASE = 'https://be-iot-gas.onrender.com/api';
  const TOKEN_KEY = 'auth_token';

  function getToken(){ return localStorage.getItem(TOKEN_KEY); }
  function setToken(t){ localStorage.setItem(TOKEN_KEY, t); }
  function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

  /**
   * Wrapper fetch ke backend.
   * - Otomatis menambahkan header Authorization HANYA jika bukan endpoint /auth/
   * - Otomatis parse JSON.
   * - Jika server balas 401 pada endpoint terproteksi, otomatis logout ke login.
   */
  async function apiFetch(path, options){
    options = options || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );
    
    // PERBAIKAN: Jangan kirim token lama ke endpoint auth (/auth/login & /auth/verify-otp)
    const token = getToken();
    if(token && !path.startsWith('/auth/')){
      headers['Authorization'] = 'Bearer ' + token;
    }

    let res;
    try{
      res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
    } catch (err){
      throw { network: true, message: 'Tidak bisa terhubung ke server. Pastikan backend Flask berjalan di ' + API_BASE };
    }

    let data = null;
    try{ data = await res.json(); } catch(e){ /* body kosong / bukan JSON */ }

    // Jika 401 Unauthorized pada endpoint non-auth, bersihkan token
    if(res.status === 401 && !path.startsWith('/auth/')){
      clearToken();
      
      // CEGAH TERLEMPAR: Jangan paksa pindah ke login jika sedang proses isi OTP
      const activeScreen = document.querySelector('.screen.active');
      if (activeScreen && activeScreen.id !== 'screen-login' && activeScreen.id !== 'screen-otp') {
        show('screen-login');
        toast('Sesi berakhir, silakan masuk kembali.');
      }
    }

    if(!res.ok){
      throw { network:false, status: res.status, message: (data && data.message) || 'Terjadi kesalahan pada server.', data };
    }
    return data;
  }

  /* =========================================================
     DATA LAYER (terhubung ke backend Flask)
     ========================================================= */
  const GasAPI = {

    // POST /api/auth/login  { phone_number }
    async sendOtp(phone){
      try{
        // Bersihkan token lama terlebih dahulu saat meminta OTP baru
        clearToken();
        const res = await apiFetch('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ phone_number: phone })
        });
        return { ok:true, data: res };
      } catch(err){
        return { ok:false, message: err.message };
      }
    },

    // POST /api/auth/verify-otp  { phone_number, otp_code }
    async verifyOtp(phone, code){
      try{
        const res = await apiFetch('/auth/verify-otp', {
          method: 'POST',
          body: JSON.stringify({ phone_number: phone, otp_code: code })
        });
        if(res && res.token){
          setToken(res.token);
        }
        return { ok:true, data: res };
      } catch(err){
        return { ok:false, message: err.message, attemptsLeft: err.data && err.data.attempts_left };
      }
    },

    // GET /api/dashboard/status
    async getCurrentReading(){
      const res = await apiFetch('/dashboard/status', { method:'GET' });
      const d = res.data;
      const stateMap = { aman:'safe', bahaya:'danger', mati:'offline' };
      return {
        state: stateMap[d.status] || 'offline',
        ppm: (d.gas_value === null || d.gas_value === undefined) ? null : d.gas_value,
        timestamp: d.last_update ? new Date(d.last_update) : new Date()
      };
    },

    // GET /api/dashboard/logs?per_page=25
    async getLogs(perPage){
      const res = await apiFetch('/dashboard/logs?per_page=' + (perPage || 25), { method:'GET' });
      return (res.data || []).map(r => ({
        t: new Date(r.timestamp),
        ppm: r.gas_value,
        state: (r.is_danger !== null && r.is_danger !== undefined)
          ? (r.is_danger ? 'danger' : 'safe')
          : (r.gas_value >= GasAPI.THRESHOLD ? 'danger' : 'safe'),
      }));
    },

    // GET /api/dashboard/gas/chart?period=1h
    async getChartHistory(period){
      const res = await apiFetch('/dashboard/gas/chart?period=' + (period || '30d'), { method:'GET' });
      return (res.data || []).map(p => ({ t: new Date(p.timestamp), ppm: p.gas_value }));
    },

    logout(){ clearToken(); },

    THRESHOLD: 2000
  };

  /* =========================================================
     STATE & DOM HELPER
     ========================================================= */
  let currentPhone = '';
  let otpTimerInterval = null;
  let pollInterval = null;
  const historyPoints = [];
  const logEntries = [];
  let lastKnownState = null;
  let chart = null;

  const $ = (sel) => document.querySelector(sel);
  const show = (id) => {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if(target) target.classList.add('active');
  };

  function toast(html, ms){
    const el = $('#toast');
    if(!el) return;
    el.innerHTML = html;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 4200);
  }

function timeHHMM(d){
    if(!d || isNaN(d)) d = new Date();
    return d.toLocaleTimeString('id-ID', {
      hour:'2-digit',
      minute:'2-digit',
      timeZone: 'Asia/Jakarta'   
    });
  }

  // Fungsi baru untuk format tanggal lengkap pada tabel (Misal: 28 Sep 2026, 16.12)
  function formatWaktuLengkap(d){
    if(!d || isNaN(d)) d = new Date();
    
    const tgl = d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Jakarta'
    });
    
    const jam = d.toLocaleTimeString('id-ID', {
      hour:'2-digit',
      minute:'2-digit',
      timeZone: 'Asia/Jakarta'
    }).replace(':', '.');
    
    return `${tgl}, ${jam}`;
  }

  /* =========================================================
     LOGIN
     ========================================================= */
  const phoneInput = $('#phone-input');
  const phoneError = $('#phone-error');
  const btnSendOtp = $('#btn-send-otp');
  const formLogin = $('#form-login');

  if(phoneInput){
    phoneInput.addEventListener('input', () => {
      phoneInput.value = phoneInput.value.replace(/\D/g,'');
      phoneError.textContent = '';
    });
  }

  async function handleSendOtp(e){
    if (e) e.preventDefault();

    const raw = phoneInput.value.trim();
    if(raw.length < 8 || raw.length > 13){
      phoneError.textContent = 'Masukkan nomor HP yang valid (8–13 digit).';
      return;
    }

    phoneError.textContent = '';
    btnSendOtp.disabled = true;
    btnSendOtp.textContent = 'Mengirim...';

    currentPhone = '+62' + raw;
    const res = await GasAPI.sendOtp(currentPhone);

    btnSendOtp.disabled = false;
    btnSendOtp.textContent = 'Kirim kode OTP';

    if(!res.ok){
      phoneError.textContent = res.message || 'Gagal mengirim OTP. Coba lagi.';
      return;
    }

    $('#otp-phone-display').textContent = currentPhone;
    $('#topbar-phone').textContent = currentPhone;
    resetOtpBoxes();
    startOtpTimer();
    show('screen-otp');
    setTimeout(() => {
      const firstBox = document.querySelector('.otp-box');
      if(firstBox) firstBox.focus();
    }, 150);

    let msg = 'Kode OTP telah dikirim ke ' + currentPhone + '.';
    if(res.data && res.data.otp){
      msg += ' (Kode Dev: <span class="toast-code">' + res.data.otp + '</span>)';
    }
    toast(msg, 5000);
  }

  //if(btnSendOtp) btnSendOtp.addEventListener('click', handleSendOtp);
  if(formLogin) formLogin.addEventListener('submit', handleSendOtp);

  /* =========================================================
     OTP
     ========================================================= */
  const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));
  const otpError = $('#otp-error');
  const btnVerify = $('#btn-verify-otp');
  const btnResend = $('#btn-resend');
  const otpTimerLabel = $('#otp-timer');
  const formOtp = $('#form-otp');

  function resetOtpBoxes(){
    otpBoxes.forEach(b => b.value = '');
    if(otpError) otpError.textContent = '';
  }

  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g,'').slice(0,1);
      if(box.value && i < otpBoxes.length - 1) otpBoxes[i+1].focus();
      if(otpError) otpError.textContent = '';
    });
    box.addEventListener('keydown', (e) => {
      if(e.key === 'Backspace' && !box.value && i > 0){
        otpBoxes[i-1].focus();
      } else if(e.key === 'Enter'){
        e.preventDefault();
        handleVerifyOtp(e);
      }
    });
    box.addEventListener('paste', (e) => {
      const text = (e.clipboardData.getData('text') || '').replace(/\D/g,'');
      if(text.length){
        e.preventDefault();
        text.slice(0,6).split('').forEach((ch, idx) => { if(otpBoxes[idx]) otpBoxes[idx].value = ch; });
        const next = otpBoxes[Math.min(text.length, 5)];
        if(next) next.focus();
      }
    });
  });

  function startOtpTimer(){
    clearInterval(otpTimerInterval);
    let secs = 30;
    btnResend.disabled = true;
    otpTimerLabel.textContent = 'Kirim ulang dalam 0:' + String(secs).padStart(2,'0');
    otpTimerInterval = setInterval(() => {
      secs -= 1;
      if(secs <= 0){
        clearInterval(otpTimerInterval);
        otpTimerLabel.textContent = 'Belum menerima kode?';
        btnResend.disabled = false;
        return;
      }
      otpTimerLabel.textContent = 'Kirim ulang dalam 0:' + String(secs).padStart(2,'0');
    }, 1000);
  }

  btnResend.addEventListener('click', async (e) => {
    if (e) e.preventDefault();
    if(btnResend.disabled) return;
    btnResend.disabled = true;
    const res = await GasAPI.sendOtp(currentPhone);
    if(!res.ok){
      if(otpError) otpError.textContent = res.message || 'Gagal mengirim ulang OTP.';
      btnResend.disabled = false;
      return;
    }
    resetOtpBoxes();
    startOtpTimer();
    if(otpBoxes[0]) otpBoxes[0].focus();
    let msg = 'Kode baru telah dikirim ke ' + currentPhone + '.';
    if(res.data && res.data.otp){
      msg += ' (Kode Dev: <span class="toast-code">' + res.data.otp + '</span>)';
    }
    toast(msg, 5000);
  });

  async function handleVerifyOtp(e){
    if (e) e.preventDefault();
    const code = otpBoxes.map(b => b.value).join('');
    if(code.length !== 6){
      if(otpError) otpError.textContent = 'Masukkan 6 digit kode OTP.';
      return;
    }
    btnVerify.disabled = true;
    btnVerify.textContent = 'Memverifikasi...';

    const res = await GasAPI.verifyOtp(currentPhone, code);

    btnVerify.disabled = false;
    btnVerify.textContent = 'Verifikasi & masuk';

    if(!res.ok){
      let msg = res.message || 'Kode salah. Coba lagi.';
      if(res.attemptsLeft !== undefined && res.attemptsLeft !== null){
        msg += ' (' + res.attemptsLeft + ' percobaan tersisa)';
      }
      if(otpError) otpError.textContent = msg;
      otpBoxes.forEach(b => b.value = '');
      if(otpBoxes[0]) otpBoxes[0].focus();
      return;
    }

    clearInterval(otpTimerInterval);
    enterDashboard();
  }

  //if(btnVerify) btnVerify.addEventListener('click', handleVerifyOtp);
  if(formOtp) formOtp.addEventListener('submit', handleVerifyOtp);

  $('#btn-back-login').addEventListener('click', (e) => {
    if (e) e.preventDefault();
    clearInterval(otpTimerInterval);
    show('screen-login');
  });

  /* =========================================================
     LOGOUT
     ========================================================= */
  $('#btn-logout').addEventListener('click', (e) => {
    if (e) e.preventDefault();
    clearInterval(pollInterval);
    GasAPI.logout();
    if(phoneInput) phoneInput.value = '';
    show('screen-login');
  });

  /* =========================================================
     DASHBOARD
     ========================================================= */
  const STATE_META = {
    safe:    { label:'AMAN',      title:'Kondisi lingkungan aman',   desc:'Kadar gas di bawah ambang batas. LED hijau menyala, sirine mati.' },
    danger:  { label:'BERBAHAYA', title:'Terdeteksi kebocoran gas',  desc:'Kadar gas melewati batas aman. LED merah &amp; sirine aktif, notifikasi dikirim ke WhatsApp.' },
    offline: { label:'PERANGKAT MATI', title:'Perangkat tidak merespons', desc:'Tidak ada data selama 2 menit terakhir. LED biru menyala, sirine dinonaktifkan.' }
  };

  async function enterDashboard(){
    show('screen-dashboard');
    initChart();
    historyPoints.length = 0;
    logEntries.length = 0;
    lastKnownState = null;
    renderLog();

    try{
      const chartHistory = await GasAPI.getChartHistory('30d');
      chartHistory.slice(-30).forEach(p => historyPoints.push({ t: p.t, ppm: p.ppm }));
      updateChart();
    } catch(err){ /* abaikan jika gagal */ }

    try{
      const logs = await GasAPI.getLogs(25);
      logEntries.length = 0;
      logs.forEach(l => logEntries.push({
        t: l.t, state: l.state, ppm: l.ppm,
        label: l.state === 'danger' ? 'Kadar gas melewati ambang batas' : 'Pembacaan normal'
      }));
      renderLog();
    } catch(err){ /* abaikan jika gagal */ }

    async function tick(){
    // TOMBOL MATI: Jika token kosong, hentikan interval sepenuhnya dan jangan lakukan apa-apa
    if (!getToken()) {
      clearInterval(pollInterval);
      return;
    }

    try{
      const reading = await GasAPI.getCurrentReading();
      applyReading(reading);
    } catch(err){
      if(err.network){
        toast(err.message, 4000);
      }
    }
  }

    if (!getToken()) return;

    clearInterval(pollInterval);
    pollInterval = setInterval(tick, 4000);
  }

  function applyReading(reading){
    const meta = STATE_META[reading.state] || STATE_META.offline;
    const hero = $('#hero');
    if(hero) hero.className = 'hero state-' + reading.state;

    if($('#status-pill-text')) $('#status-pill-text').textContent = meta.label;
    if($('#status-label')) $('#status-label').textContent = meta.title;
    if($('#status-desc')) $('#status-desc').innerHTML = meta.desc;
    if($('#hero-updated')) $('#hero-updated').textContent = 'diperbarui ' + timeHHMM(reading.timestamp);
    if($('#topbar-dot')) $('#topbar-dot').style.background = reading.state === 'safe' ? 'var(--safe)' : reading.state === 'danger' ? 'var(--danger)' : 'var(--offline)';

    const valEl = $('#reading-value');
    if(valEl){
      if(reading.ppm === null){
        valEl.innerHTML = '&ndash;&ndash;<span>ppm</span>';
        if($('#threshold-fill')) $('#threshold-fill').style.width = '0%';
      } else {
        valEl.innerHTML = reading.ppm + '<span>ppm</span>';
        const pct = Math.min(100, (reading.ppm / 3000) * 100);
        if($('#threshold-fill')) $('#threshold-fill').style.width = pct + '%';
      }
    }

    if($('#mini-siren')){
      $('#mini-siren').textContent = reading.state === 'danger' ? 'Aktif' : 'Nonaktif';
      $('#mini-siren').className = 'card-mini-value ' + (reading.state === 'danger' ? '' : 'ok');
    }
    if($('#mini-conn')){
      $('#mini-conn').textContent = reading.state === 'offline' ? 'Terputus' : 'Terhubung';
      $('#mini-conn').className = 'card-mini-value ' + (reading.state === 'offline' ? 'off' : 'ok');
    }

    if(reading.ppm !== null){
      historyPoints.push({ t: reading.timestamp, ppm: reading.ppm });
      if(historyPoints.length > 30) historyPoints.shift();
      updateChart();
    }

    if(reading.state !== lastKnownState){
      addLogEntry(reading);
      lastKnownState = reading.state;
    }
  }

  function addLogEntry(reading){
    const labelMap = {
      safe: 'Kondisi kembali aman',
      danger: 'Kebocoran gas terdeteksi',
      offline: 'Perangkat berhenti mengirim data'
    };
    logEntries.unshift({
      t: reading.timestamp,
      state: reading.state,
      ppm: reading.ppm,
      label: labelMap[reading.state] || 'Perubahan status'
    });
    if(logEntries.length > 25) logEntries.pop();
    renderLog();
  }

  function renderLog(){
    const list = $('#log-list');
    if(!list) return;
    if($('#log-count')) $('#log-count').textContent = logEntries.length + ' kejadian';
    if(!logEntries.length){
      list.innerHTML = '<div class="empty-note">Belum ada riwayat kejadian.</div>';
      return;
    }

    list.innerHTML = logEntries.map(e => `
      <div class="log-row">
        <div class="log-time">${formatWaktuLengkap(e.t)}</div> 
        <div class="log-event">${e.label}</div>
        <div class="log-ppm">${e.ppm !== null ? e.ppm + ' ppm' : '&ndash;'}</div>
        <div class="log-tag ${e.state}">${(STATE_META[e.state] || STATE_META.offline).label}</div>
      </div>
    `).join('');
  }

  function initChart(){
    if(chart) return;
    const canvas = document.getElementById('gasChart');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Kadar gas',
            data: [],
            borderColor: '#e3a13d',
            backgroundColor: 'rgba(227,161,61,0.10)',
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 2
          },
          {
            label: 'Batas bahaya',
            data: [],
            borderColor: 'rgba(217,79,61,0.55)',
            borderDash: [6,5],
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // TAMBAHKAN BAGIAN LAYOUT INI:
        layout: {
          padding: {
            left: 15,
            right: 15,
            top: 10,
            bottom: 0
          }
        },
        animation: { duration: 300 },
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { display:false } },
        scales: {
          x: { grid: { color: '#23282d' }, ticks: { color: '#5f666d', maxTicksLimit: 6, font:{ family: 'IBM Plex Mono', size: 10 } } },
          y: { grid: { color: '#23282d' }, ticks: { color: '#5f666d', font:{ family: 'IBM Plex Mono', size: 10 } }, suggestedMin: 0, suggestedMax: 2600 }
        }
      }
    });
  }

  function updateChart(){
    if(!chart) return;
    chart.data.labels = historyPoints.map(p => timeHHMM(p.t));
    chart.data.datasets[0].data = historyPoints.map(p => p.ppm);
    chart.data.datasets[1].data = historyPoints.map(() => GasAPI.THRESHOLD);
    chart.update('none');
  }

  

  /* =========================================================
     INISIALISASI APLIKASI
     ========================================================= */
  async function initApp(){
    const token = getToken();
    if(token){
      try {
        await enterDashboard();
        return;
      } catch(e){
        clearToken();
      }
    }
    show('screen-login');
  }

  initApp();

})();