export function renderProjectWikiDashboardBridgeHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ProjectWiki</title>
    <script>
      try {
        window.localStorage.setItem('activeTab', 'memory');
      } catch (_) {}
      window.location.replace('/');
    </script>
  </head>
  <body>
    <main style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px;">
      <h1>ProjectWiki has replaced the direct memory dashboard.</h1>
      <p>Opening the ProjectWiki workspace view...</p>
      <p><a href="/">Open ProjectWiki</a></p>
    </main>
  </body>
</html>`;
}
