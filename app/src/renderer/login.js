// Login-Fenster: holt eine Session und übergibt sie an den Main-Prozess,
// der dann das Overlay öffnet.

const el = (id) => document.getElementById(id);

function validToken(t) {
  return typeof t === 'string' && t.split('.').length === 3;
}

el('loginBtn').onclick = () => window.bf.openLogin();

el('manualBtn').onclick = () => {
  const t = el('manualSession').value.trim();
  if (!validToken(t)) { el('err').textContent = 'Ungültiges Token-Format.'; return; }
  window.bf.sessionReady(t);
};

el('manualSession').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('manualBtn').click();
});
