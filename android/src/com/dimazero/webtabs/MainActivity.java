package com.dimazero.webtabs;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * web-tabs для планшета: тот же веб-интерфейс (assets/www) в WebView + мост к файлам.
 * Песни — JSON-файлы, выбранные через системное окно Android (там есть Google Диск):
 * приложение читает и пишет их, а Диск сам синхронизирует с облаком и другими устройствами.
 */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://webtabs.app/";
    private static final int REQ_OPEN = 1, REQ_CREATE = 2, REQ_TREE = 3;

    private WebView web;
    private PianoReceiver piano;
    private SharedPreferences prefs;
    private String pendingReq;                         // номер запроса JS, ждущего выбора файла

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("songs", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // отладка WebView по USB (adb): с компьютера можно прочитать/записать песню через само приложение
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "WebTabsAndroid");
        // Файлы приложения отдаём с «https://webtabs.app/…» из assets/www — так работают ES-модули
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.toString().startsWith(ORIGIN)) return false;
                if (request.isForMainFrame() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (android.content.ActivityNotFoundException ignored) { }
                }
                return true;
            }
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!u.toString().startsWith(ORIGIN))
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, null);
                String path = u.getPath() == null || u.getPath().equals("/") ? "/index.html" : u.getPath();
                try {
                    return new WebResourceResponse(mime(path), "utf-8", getAssets().open("www" + path));
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                }
            }
        });
        // окна prompt/confirm из JS — свои, с заголовком web-tabs (а не «The page at … says»)
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsPrompt(WebView v, String url, String msg, String def, android.webkit.JsPromptResult r) {
                android.widget.EditText input = new android.widget.EditText(MainActivity.this);
                input.setText(def); input.setSelectAllOnFocus(true);
                new android.app.AlertDialog.Builder(MainActivity.this).setTitle(msg).setView(input)
                        .setPositiveButton("OK", (d, w) -> r.confirm(input.getText().toString()))
                        .setNegativeButton("Отмена", (d, w) -> r.cancel())
                        .setOnCancelListener(d -> r.cancel()).show();
                return true;
            }
            @Override
            public boolean onJsConfirm(WebView v, String url, String msg, android.webkit.JsResult r) {
                new android.app.AlertDialog.Builder(MainActivity.this).setMessage(msg)
                        .setPositiveButton("Да", (d, w) -> r.confirm())
                        .setNegativeButton("Нет", (d, w) -> r.cancel())
                        .setOnCancelListener(d -> r.cancel()).show();
                return true;
            }
        });
        // Android 15 рисует приложение под системными панелями — отступаем на их размер
        // (и на высоту клавиатуры, чтобы поле ввода не пряталось под ней)
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        root.addView(web);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets in = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                l = in.left; t = in.top; r = in.right; b = in.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        setContentView(root);
        web.loadUrl(ORIGIN + "index.html");
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private void stopPiano() {
        if (piano != null) piano.close();
        piano = null;
    }

    @Override
    protected void onDestroy() {
        stopPiano();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // «Назад» сначала закрывает проигрыватель, потом снимает выделение блока (как Esc), а не закрывает приложение
        web.evaluateJavascript("(function(){var p=document.getElementById('player');" +
                "if(p&&!p.hidden){document.getElementById('pl-close').click();return 1}" +
                "var s=window.webTabs;if(s&&s.selected){" +
                "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return 1}return 0})()",
                r -> { if (!"1".equals(r)) MainActivity.super.onBackPressed(); });
    }

    // ---------- список песен: uri → название ----------
    private JSONObject songs() {
        try { return new JSONObject(prefs.getString("list", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    private void saveSongs(JSONObject o) { prefs.edit().putString("list", o.toString()).apply(); }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return uri.getLastPathSegment();
    }

    private long lastModified(Uri uri) {
        try (Cursor c = getContentResolver().query(uri,
                new String[]{DocumentsContract.Document.COLUMN_LAST_MODIFIED}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) { }
        return 0;
    }

    private String titleOf(Uri uri) {
        try {
            JSONObject song = new JSONObject(readText(uri));
            if (song.optString("title").length() > 0) return song.getString("title");
        } catch (Exception ignored) { }
        String n = displayName(uri);
        return n != null && n.endsWith(".json") ? n.substring(0, n.length() - 5) : n;
    }

    private String readText(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private void writeText(Uri uri, String text) throws Exception {
        ContentResolver cr = getContentResolver();
        // Google Диск выгружает изменения в облако только для режима «w» (с «wt» правка остаётся
        // на устройстве); «w» у Диска и так перезаписывает файл целиком
        try (android.os.ParcelFileDescriptor pfd = cr.openFileDescriptor(uri, "w");
             java.io.FileOutputStream o = new java.io.FileOutputStream(pfd.getFileDescriptor())) {
            byte[] data = text.getBytes(StandardCharsets.UTF_8);
            try { o.getChannel().truncate(0); } catch (Exception ignored) { }   // на случай провайдера, который не обрезает
            o.write(data);
            o.flush();
            try { pfd.getFileDescriptor().sync(); } catch (Exception ignored) { }
        }
    }

    private static String err(Exception e) {
        try { return new JSONObject().put("error", String.valueOf(e.getMessage())).toString(); }
        catch (Exception x) { return "{\"error\":\"ошибка\"}"; }
    }

    private void answer(String reqId, String json) {
        String js = "window.__androidResult(" + JSONObject.quote(reqId) + "," + JSONObject.quote(json) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }


    // ---------- папка с песнями на Диске ----------
    private Uri tree() {
        String t = prefs.getString("tree", null);
        return t == null ? null : Uri.parse(t);
    }

    private Uri treeDoc(Uri tree) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }

    private JSONObject folderJson() throws Exception {
        Uri t = tree();
        JSONObject o = new JSONObject();
        if (t != null) o.put("uri", t.toString()).put("name", displayName(treeDoc(t)));
        return o;
    }

    /** Все песни в папке: JSON-файлы, у которых есть список блоков */
    private JSONArray folderSongs(Uri t) throws Exception {
        ContentResolver cr = getContentResolver();
        String treeId = DocumentsContract.getTreeDocumentId(t);
        if (Build.VERSION.SDK_INT >= 26) {             // попросить Диск подтянуть свежий список
            try { cr.refresh(treeDoc(t), null, null); } catch (Exception ignored) { }
        }
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(t, treeId);
        JSONArray arr = new JSONArray();
        Log.i("webtabs", "список папки: " + children);
        try (Cursor c = cr.query(children, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED},
                null, null, null)) {
            Log.i("webtabs", "файлов в папке: " + (c == null ? "нет курсора" : c.getCount())
                    + (c != null && c.getExtras() != null ? " loading=" + c.getExtras().getBoolean(DocumentsContract.EXTRA_LOADING) : ""));
            while (c != null && c.moveToNext()) {
                String name = c.getString(1), mime = c.getString(2);
                Log.i("webtabs", "  " + name + " [" + mime + "]");
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) continue;
                if (name == null || !(name.toLowerCase().endsWith(".json") || "application/json".equals(mime))) continue;
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(t, c.getString(0));
                String title = name.replaceAll("(?i)\\.json$", "");
                try {
                    JSONObject song = new JSONObject(readText(doc));
                    if (!song.has("blocks")) continue;    // чужой JSON — не песня
                    if (song.optString("title").length() > 0) title = song.getString("title");
                } catch (Exception e) { Log.w("webtabs", "не прочитался " + name + ": " + e); continue; }
                arr.put(new JSONObject().put("id", doc.toString()).put("title", title)
                        .put("mtime", c.isNull(3) ? 0 : c.getLong(3)));
            }
        }
        return arr;
    }

    // ---------- выбор и создание файла ----------
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        String reqId = pendingReq;
        pendingReq = null;
        if (reqId == null) return;
        if (res != RESULT_OK || data == null || data.getData() == null) {
            answer(reqId, "{\"error\":\"отменено\"}");
            return;
        }
        Uri uri = data.getData();
        if (req == REQ_TREE) {                         // папка с песнями на Диске — запоминаем навсегда
            new Thread(() -> {
                try {
                    getContentResolver().takePersistableUriPermission(uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    prefs.edit().putString("tree", uri.toString()).apply();
                    answer(reqId, folderJson().toString());
                } catch (Exception e) { answer(reqId, err(e)); }
            }).start();
            return;
        }
        new Thread(() -> {
            try {
                int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                try { getContentResolver().takePersistableUriPermission(uri, flags); } catch (Exception ignored) { }
                String title = req == REQ_CREATE ? prefs.getString("newTitle", "Новая песня") : titleOf(uri);
                JSONObject list = songs();
                list.put(uri.toString(), title);
                saveSongs(list);
                answer(reqId, new JSONObject().put("id", uri.toString()).put("title", title).toString());
            } catch (Exception e) { answer(reqId, err(e)); }
        }).start();
    }

    /** Методы, доступные из JS как window.WebTabsAndroid.* */
    private class Bridge {
        @JavascriptInterface
        public void startPiano(String session) {
            runOnUiThread(() -> {
                if (isDestroyed() || isFinishing()) return;
                stopPiano();
                String pin = prefs.getString("pianoPin", null);
                if (pin == null) {
                    pin = String.format(java.util.Locale.ROOT, "%06d", new java.security.SecureRandom().nextInt(1000000));
                    prefs.edit().putString("pianoPin", pin).apply();
                }
                piano = new PianoReceiver(MainActivity.this, pin, (event, value, detail) -> {
                    String js = "window.__wtRemoteMidi?.(" + JSONObject.quote(session) + "," +
                            JSONObject.quote(event) + "," + value + "," + JSONObject.quote(detail) + ")";
                    runOnUiThread(() -> { if (!isDestroyed()) web.evaluateJavascript(js, null); });
                });
                piano.start();
            });
        }

        @JavascriptInterface
        public void stopPianoInput() { runOnUiThread(() -> stopPiano()); }
        @JavascriptInterface
        public String list() {
            try {
                Uri t = tree();
                if (t != null) return new JSONObject().put("songs", folderSongs(t)).toString();
                JSONObject o = songs();
                JSONArray arr = new JSONArray();
                for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                    String id = it.next();
                    arr.put(new JSONObject().put("id", id).put("title", o.getString(id)));
                }
                return new JSONObject().put("songs", arr).toString();
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String read(String id) {
            try { return new JSONObject().put("text", readText(Uri.parse(id))).toString(); }
            catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String write(String id, String text) {
            try {
                Uri uri = Uri.parse(id);
                writeText(uri, text);
                try {                                  // название в списке — из песни
                    String title = new JSONObject(text).optString("title");
                    if (title.length() > 0) { JSONObject o = songs(); o.put(id, title); saveSongs(o); }
                } catch (Exception ignored) { }
                return new JSONObject().put("mtime", lastModified(uri)).toString();
            } catch (Exception e) { return err(e); }
        }

        /** Синхронизация: попросить провайдер (Google Диск) подтянуть свежую версию и прочитать её */
        @JavascriptInterface
        public String sync(String id) {
            try {
                Uri uri = Uri.parse(id);
                if (Build.VERSION.SDK_INT >= 26) {
                    try { getContentResolver().refresh(uri, null, null); } catch (Exception ignored) { }
                }
                return new JSONObject().put("text", readText(uri)).put("mtime", lastModified(uri)).toString();
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String mtime(String id) {
            try { return new JSONObject().put("mtime", lastModified(Uri.parse(id))).toString(); }
            catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String forget(String id) {
            try {
                JSONObject o = songs(); o.remove(id); saveSongs(o);
                try {
                    getContentResolver().releasePersistableUriPermission(Uri.parse(id),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (Exception ignored) { }
                return "{}";
            } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public String folder() {
            try { return folderJson().toString(); } catch (Exception e) { return err(e); }
        }

        @JavascriptInterface
        public void pickFolder(String reqId) {
            pendingReq = reqId;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            runOnUiThread(() -> startActivityForResult(i, REQ_TREE));
        }

        @JavascriptInterface
        public void open(String reqId) {
            pendingReq = reqId;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"});
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            runOnUiThread(() -> startActivityForResult(i, REQ_OPEN));
        }

        @JavascriptInterface
        public void create(String reqId, String title) {
            Uri t = tree();
            String fileName = title.replaceAll("[\\\\/:*?\"<>|]", " ").trim() + ".json";
            if (t != null) {                           // папка подключена — создаём прямо в ней, без окон
                new Thread(() -> {
                    try {
                        Uri doc = DocumentsContract.createDocument(getContentResolver(), treeDoc(t), "application/json", fileName);
                        if (doc == null) throw new Exception("Диск не создал файл");
                        answer(reqId, new JSONObject().put("id", doc.toString()).put("title", title).toString());
                    } catch (Exception e) { answer(reqId, err(e)); }
                }).start();
                return;
            }
            pendingReq = reqId;
            prefs.edit().putString("newTitle", title).apply();
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("application/json");
            i.putExtra(Intent.EXTRA_TITLE, title.replaceAll("[\\\\/:*?\"<>|]", " ").trim() + ".json");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            runOnUiThread(() -> startActivityForResult(i, REQ_CREATE));
        }
    }
}
