(() => {
  "use strict";

  const installButton = document.getElementById("installPwaButton");
  const guide = document.getElementById("pwaInstallGuide");
  const closeGuide = document.getElementById("closePwaGuide");
  const guideTitle = document.getElementById("pwaGuideTitle");
  const guideText = document.getElementById("pwaGuideText");
  const guideHint = document.getElementById("pwaGuideHint");
  const guideAction = document.getElementById("pwaGuideAction");
  const installStatus = document.getElementById("pwaInstallStatus");
  let deferredPrompt = null;

  const ua = navigator.userAgent || "";
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isEdge = /edg\//i.test(ua);
  const isChrome = /chrome|crios/i.test(ua) && !isEdge;
  const isOpera = /opr\//i.test(ua);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  function setButtonVisible(visible) {
    if (!installButton) return;
    installButton.classList.toggle("hidden", !visible || isStandalone);
    installButton.classList.toggle("is-installed", isStandalone);
    installButton.setAttribute("aria-hidden", visible && !isStandalone ? "false" : "true");
  }

  function openGuide(mode = "help") {
    if (!guide) return;

    if (mode === "ios" || isIOS) {
      guideTitle.textContent = "Instalar THESO en iPhone o iPad";
      guideText.innerHTML = "Abre THESO en <strong>Safari</strong>, toca el botón <strong>Compartir</strong> y selecciona <strong>Agregar a pantalla de inicio</strong>.";
      guideHint.textContent = "Apple no permite abrir el instalador con un botón automático; la instalación se realiza desde el menú Compartir.";
      guideAction?.classList.add("hidden");
    } else if (mode === "ready" && deferredPrompt) {
      guideTitle.textContent = "THESO está listo para instalarse";
      guideText.innerHTML = "Presiona <strong>Instalar ahora</strong> para abrir el instalador de tu navegador.";
      guideHint.textContent = "La aplicación se abrirá en su propia ventana y seguirá usando tu cuenta y tus salas.";
      guideAction?.classList.remove("hidden");
    } else {
      guideTitle.textContent = "Instalar THESO en tu PC";
      guideText.innerHTML = isEdge
        ? "En Microsoft Edge abre el menú <strong>⋯</strong>, entra en <strong>Aplicaciones</strong> y selecciona <strong>Instalar THESO</strong>."
        : "En Chrome u Opera busca el icono de instalación en la parte derecha de la barra de direcciones. También puedes abrir el menú del navegador y elegir <strong>Instalar THESO</strong>.";
      guideHint.textContent = location.protocol === "https:"
        ? "Si la opción todavía no aparece, recarga la página una vez y espera unos segundos para que el navegador valide la aplicación."
        : "La instalación requiere HTTPS. En Render funcionará con la dirección pública segura de tu sitio.";
      guideAction?.classList.add("hidden");
    }

    guide.classList.remove("hidden");
  }

  async function requestInstall() {
    if (!deferredPrompt) {
      openGuide(isIOS ? "ios" : "help");
      return;
    }

    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setButtonVisible(false);
    }
    deferredPrompt = null;
  }

  // El botón propio de THESO siempre se muestra en navegador mientras la app no esté instalada.
  // Así el usuario no depende de que Chrome/Edge decidan mostrar su icono en la barra de direcciones.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setButtonVisible(true), { once: true });
  } else {
    setButtonVisible(true);
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
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
    setButtonVisible(true);
    installButton?.classList.add("is-ready");
    if (installStatus) installStatus.textContent = "Listo para instalar";
    installButton?.setAttribute("title", "Instalar THESO en este dispositivo");
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    setButtonVisible(false);
    localStorage.setItem("theso-pwa-installed", "1");
    if (installStatus) installStatus.textContent = "Aplicación instalada";
  });

  installButton?.addEventListener("click", requestInstall);
  guideAction?.addEventListener("click", requestInstall);
  closeGuide?.addEventListener("click", () => guide?.classList.add("hidden"));
  guide?.addEventListener("click", event => {
    if (event.target === guide) guide.classList.add("hidden");
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") guide?.classList.add("hidden");
  });
})();
