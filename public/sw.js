self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    self.clients.claim()
  );
});

self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data.json();
  } catch {}

  event.waitUntil(
    self.registration.showNotification(
      data.title || "Nobitex Signal",
      {
        body:
          data.body ||
          "سیگنال جدید دریافت شد.",
        tag: "nobitex-signal",
        data: {
          url: data.url || "/"
        }
      }
    )
  );
});

self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();

    event.waitUntil(
      self.clients
        .matchAll({
          type: "window",
          includeUncontrolled: true
        })
        .then(clients => {

          for (const client of clients) {
            if ("focus" in client) {
              return client.focus();
            }
          }

          return self.clients.openWindow(
            event.notification.data?.url || "/"
          );
        })
    );
  }
);
