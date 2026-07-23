(() => {
  "use strict";
  const installButton = document.getElementById("installPwaButton");
  const guide = document.getElementById("pwaInstallGuide");
  const closeGuide = document.getElementById("closePwaGuide");
  let deferredPrompt = null;

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function showButton() {
    if (!installButton || isStandalone) return;
    installButton.classList.remove("hidden");
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage("SKIP_WAITING");
            }
          });
        });
      } catch (error) {
        console.warn("No se pudo registrar la PWA:", error);
      }
    });
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    showButton();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installButton?.classList.add("hidden");
    localStorage.setItem("theso-pwa-installed", "1");
  });

  if (isIOS && !isStandalone) showButton();

  installButton?.addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      return;
    }
    guide?.classList.remove("hidden");
  });

  closeGuide?.addEventListener("click", () => guide?.classList.add("hidden"));
  guide?.addEventListener("click", event => {
    if (event.target === guide) guide.classList.add("hidden");
  });
})();
