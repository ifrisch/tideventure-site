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
  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = contactForm.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.textContent = 'Sending…';
    btn.disabled = true;

    // Simulate submit — replace with real endpoint (Cloudflare Workers, Formspree, etc.)
    setTimeout(() => {
      const successMsg = document.getElementById('form-success');
      if (successMsg) successMsg.hidden = false;
      contactForm.reset();
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  });
}

// ---- Scroll reveal (lightweight) ----
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.service-card, .why-item, .team-card').forEach(el => {
  el.classList.add('reveal');
  observer.observe(el);
});

// ---- Inject scroll reveal CSS ----
const style = document.createElement('style');
style.textContent = `
  .reveal { opacity: 0; transform: translateY(20px); transition: opacity 0.5s ease, transform 0.5s ease; }
  .reveal.revealed { opacity: 1; transform: none; }
`;
document.head.appendChild(style);
