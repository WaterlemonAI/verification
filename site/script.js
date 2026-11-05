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

const exampleSolutions = {
  banking: { title: 'Banking customer onboarding', checks: ['Identity and business verification', 'Sanctions, PEP and adverse-media screening', 'Payment evidence where relevant'], monitoring: 'Re-screen risk signals on the review cadence and triggers set by your policy.' },
  crypto: { title: 'Crypto customer onboarding', checks: ['Identity-document and entity checks', 'Sanctions, PEP and watchlist screening', 'Adverse-media review'], monitoring: 'Refresh sanctions, PEP and media signals at the cadence your policy requires.' },
  finance: { title: 'Financial services onboarding', checks: ['Identity and business records', 'Sanctions and PEP screening', 'Adverse-media and payment context'], monitoring: 'Repeat relevant risk checks throughout the customer relationship.' },
  loans: { title: 'Loan applicant onboarding', checks: ['Identity-document field review', 'Bank-statement analysis where enabled', 'Sanctions and PEP checks where relevant'], monitoring: 'Review material changes and re-run required checks during the loan relationship.' },
  supplier: { title: 'Supplier onboarding', checks: ['Trade licence and corporate documents', 'Entity and financial-crime screening', 'Merchant website review'], monitoring: 'Refresh licence and risk signals as the supplier relationship continues.' },
  student: { title: 'Student onboarding', checks: ['Passport or Emirates ID field review', 'Supporting-document extraction', 'Name screening where required'], monitoring: 'Repeat relevant checks at enrolment milestones set by your policy.' },
  passenger: { title: 'Passenger onboarding', checks: ['Passport and MRZ field extraction', 'Identity-data review', 'Name screening where required'], monitoring: 'Re-screen relevant information when the journey or travel details change.' },
  tenant: { title: 'Tenant onboarding', checks: ['Passport or Emirates ID field review', 'Ejari verification', 'Risk screening where applicable'], monitoring: 'Refresh tenancy and identity evidence at renewal or a material change.' },
  partner: { title: 'Business partner onboarding', checks: ['Trade licence and entity verification', 'Sanctions, PEP and adverse-media screening', 'Merchant or payment context where relevant'], monitoring: 'Re-check business status and risk signals across the partnership.' },
  employee: { title: 'Employee onboarding', checks: ['Identity-document field review', 'Supporting-document extraction', 'Risk screening where applicable'], monitoring: 'Review relevant records at policy-defined intervals where permitted.' }
};

const solutionButtons = [...document.querySelectorAll('[data-solution]')];
const solutionTitle = document.querySelector('#solution-title');
const solutionChecks = document.querySelector('#solution-checks');
const solutionMonitoring = document.querySelector('#solution-monitoring');
for (const button of solutionButtons) button.addEventListener('click', () => {
  const selected = exampleSolutions[button.dataset.solution];
  if (!selected) return;
  for (const item of solutionButtons) item.setAttribute('aria-pressed', String(item === button));
  solutionTitle.textContent = selected.title;
  solutionChecks.replaceChildren(...selected.checks.map((check) => {
    const item = document.createElement('li'); item.textContent = check; return item;
  }));
  solutionMonitoring.textContent = selected.monitoring;
});

const publisherField = document.querySelector('.publisher-field');
const publisherTiles = [...document.querySelectorAll('.publisher-grid .publisher')];
if (publisherField && publisherTiles.length) {
  const count = document.querySelector('#publisher-scan-count');
  const progress = document.querySelector('.publisher-scan-progress span');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let inView = false;
  let scanTimer;
  let scanIndex = -1;

  const stopScan = () => {
    clearInterval(scanTimer);
    scanTimer = undefined;
  };
  const scanNext = () => {
    scanIndex = (scanIndex + 1) % publisherTiles.length;
    if (scanIndex === 0) {
      publisherTiles.forEach((tile) => tile.classList.remove('is-scanned'));
      progress.style.transition = 'none';
      requestAnimationFrame(() => { progress.style.transition = ''; });
    }
    publisherTiles.forEach((tile, index) => tile.classList.toggle('is-active', index === scanIndex));
    publisherTiles[scanIndex].classList.add('is-scanned');
    count.textContent = String(scanIndex + 1).padStart(2, '0');
    progress.style.width = `${(scanIndex + 1) / publisherTiles.length * 100}%`;
  };
  const syncScan = () => {
    if (reducedMotion.matches) {
      stopScan();
      publisherTiles.forEach((tile) => { tile.classList.add('is-scanned'); tile.classList.remove('is-active'); });
      count.textContent = String(publisherTiles.length).padStart(2, '0');
      progress.style.width = '100%';
    } else if (inView && document.visibilityState === 'visible') {
      if (!scanTimer) {
        scanNext();
        scanTimer = setInterval(scanNext, 260);
      }
    } else {
      stopScan();
    }
  };
  new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    syncScan();
  }, { threshold: 0.15 }).observe(publisherField);
  reducedMotion.addEventListener('change', syncScan);
  document.addEventListener('visibilitychange', syncScan);
  syncScan();
}

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
