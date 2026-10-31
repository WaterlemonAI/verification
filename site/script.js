const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 },
);

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector("#site-navigation");

menuButton?.addEventListener("click", () => {
  const open = navigation?.classList.toggle("open") || false;
  menuButton.setAttribute("aria-expanded", String(open));
});

navigation?.addEventListener("click", (event) => {
  if (!event.target.closest("a")) return;
  navigation.classList.remove("open");
  menuButton?.setAttribute("aria-expanded", "false");
});

function confirmExternalLink(event) {
  const link = event.target.closest?.('a[href]');
  if (!link || event.defaultPrevented) return;
  const destination = new URL(link.href);
  if (!['http:', 'https:'].includes(destination.protocol) || destination.origin === location.origin) return;
  if ((location.pathname === '/' || location.pathname === '/index.html') && destination.origin === 'https://app.kycprobe.com') return;
  if (!window.confirm(`You will be redirected to ${destination.hostname} website. Continue?`)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
document.addEventListener('click', confirmExternalLink, true);
document.addEventListener('auxclick', confirmExternalLink, true);
