// TideVenture — main.js

// ---- Mobile nav toggle ----
const toggle = document.querySelector('.nav__toggle');
const links  = document.querySelector('.nav__links');
if (toggle && links) {
  toggle.addEventListener('click', () => {
    links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', links.classList.contains('open'));
  });
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!toggle.contains(e.target) && !links.contains(e.target)) {
      links.classList.remove('open');
    }
  });
}

// ---- Active nav link ----
const currentPage = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav__links a').forEach(a => {
  const href = a.getAttribute('href');
  if (href === currentPage || (currentPage === '' && href === 'index.html')) {
    a.classList.add('active');
  }
});

// ---- Contact form submission ----
const contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = contactForm.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.textContent = 'Sending…';
    btn.disabled = true;

    const fd = new FormData(contactForm);
    const services = [...contactForm.querySelectorAll('input[name="service"]:checked')].map(cb => cb.value);
    const payload = {
      email: fd.get('email'),
      name: [fd.get('first-name'), fd.get('last-name')].filter(Boolean).join(' ').trim(),
      phone: fd.get('phone') || '',
      services,
      notes: fd.get('message') || '',
      source: 'contact',
    };

    try {
      const res = await fetch('/api/prospect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Request failed');
      const successMsg = document.getElementById('form-success');
      if (successMsg) { successMsg.hidden = false; successMsg.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      contactForm.reset();
    } catch (err) {
      alert('Sorry, something went wrong sending your message. Please email us directly at hello@tideventurecpa.com.');
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });
}

