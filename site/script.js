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
