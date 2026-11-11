package com.ben47203.knimecli.server.http;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * Loopback-only HTTP server exposing a filtered KNIME gateway JSON-RPC API ({@code /rpc}) and side-effect-free read
 * endpoints ({@code /api/*}).
 *
 * <p>
 * Deliberately free of KNIME/OSGi imports so it can be exercised outside the platform. Every request must:
 * <ul>
 * <li>carry {@code Authorization: Bearer <token>}</li>
 * <li>have a {@code Host} of {@code 127.0.0.1:<port>} or {@code localhost:<port>} (blocks DNS rebinding)</li>
 * <li>carry no {@code Origin} header (blocks any browser-originated request)</li>
 * </ul>
 */
public final class LocalApiServer {

    /** Bumped on any breaking change to the HTTP surface. */
    public static final int API_VERSION = 2;

    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;

    /** Room for a few long-polling clients (execution waits) without starving short requests. */
    private static final int WORKER_THREADS = 8;

    /** Handles one raw JSON-RPC request; may return an empty array for notifications. */
    @FunctionalInterface
    public interface RpcHandler {
        byte[] handle(byte[] request);
    }

    /** Handles one POST /api/* call: JSON request body in, JSON response body out. */
    @FunctionalInterface
    public interface ApiHandler {
        byte[] handle(byte[] body) throws Exception; // NOSONAR: failures become 500s in one place
    }

    /** Thrown by an {@link ApiHandler} to return a specific HTTP status, e.g. 400 or 404. */
    public static final class ApiException extends Exception {
        private static final long serialVersionUID = 1L;

        private final int m_status;

        public ApiException(final int status, final String message) {
            super(message);
            m_status = status;
        }

        public int status() {
            return m_status;
        }
    }

    /** Minimal logging hook so the server doesn't depend on KNIME's NodeLogger. */
    public interface Log {
        void info(String msg);

        void warn(String msg, Throwable t);
    }

    private final RpcHandler m_rpc;

    private final Map<String, ApiHandler> m_apiRoutes;

    private final BooleanSupplier m_ready;

    private final Map<String, Object> m_statusInfo;

    private final Log m_log;

    private final byte[] m_token;

    private HttpServer m_server;

    private ExecutorService m_executor;

    private int m_port;

    /**
     * @param rpc JSON-RPC handler
     * @param apiRoutes POST handlers keyed by path, e.g. {@code /api/workflow}
     * @param ready whether the gateway may be called; when false, /rpc and /api/* answer 503
     * @param statusInfo static fields merged into the /status response
     * @param token the bearer token clients must present
     * @param log logging hook
     */
    public LocalApiServer(final RpcHandler rpc, final Map<String, ApiHandler> apiRoutes, final BooleanSupplier ready,
        final Map<String, Object> statusInfo, final String token, final Log log) {
        m_rpc = rpc;
        m_apiRoutes = Map.copyOf(apiRoutes);
        m_ready = ready;
        m_statusInfo = Map.copyOf(statusInfo);
        m_token = token.getBytes(StandardCharsets.UTF_8);
        m_log = log;
    }

    /** Binds to 127.0.0.1 on an OS-assigned port and starts serving. */
    public synchronized void start() throws IOException {
        if (m_server != null) {
            return;
        }
        var server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        var counter = new AtomicInteger();
        m_executor = Executors.newFixedThreadPool(WORKER_THREADS, r -> {
            var t = new Thread(r, "knime-cli-http-" + counter.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
        server.setExecutor(m_executor);
        server.createContext("/", this::handle);
        server.start();
        m_server = server;
        m_port = server.getAddress().getPort();
        m_log.info("knime-cli: API listening on 127.0.0.1:" + m_port);
    }

    public synchronized void stop() {
        if (m_server == null) {
            return;
        }
        m_server.stop(0);
        m_executor.shutdownNow();
        try {
            m_executor.awaitTermination(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        m_server = null;
        m_executor = null;
        m_log.info("knime-cli: API stopped");
    }

    public synchronized int getPort() {
        return m_port;
    }

    private void handle(final HttpExchange ex) throws IOException {
        try (ex) {
            var rejection = checkRequest(ex);
            if (rejection != null) {
                m_log.info("knime-cli: rejected " + ex.getRequestMethod() + " " + ex.getRequestURI().getPath() + " -> "
                    + rejection.status + " (" + rejection.message + ")");
                sendError(ex, rejection.status, rejection.message);
                return;
            }
            var path = ex.getRequestURI().getPath();
            var method = ex.getRequestMethod();
            switch (path) {
                case "/status" -> {
                    if (!"GET".equals(method)) {
                        sendError(ex, 405, "Use GET");
                        return;
                    }
                    var body = new LinkedHashMap<String, Object>(m_statusInfo);
                    body.put("apiVersion", API_VERSION);
                    body.put("ready", m_ready.getAsBoolean());
                    sendJson(ex, 200, Json.object(body));
                }
                case "/rpc" -> handleRpc(ex, method);
                default -> {
                    var api = m_apiRoutes.get(path);
                    if (api == null) {
                        sendError(ex, 404, "Unknown path");
                    } else {
                        handleApi(ex, method, path, api);
                    }
                }
            }
        } catch (RuntimeException e) { // NOSONAR: never let a handler bug kill the worker silently
            m_log.warn("Unhandled error serving request", e);
            try {
                sendError(ex, 500, "Internal error: " + e.getClass().getSimpleName());
            } catch (IOException ignored) { // NOSONAR: response may already be committed
            }
        }
    }

    /**
     * Shared preconditions for /rpc and /api/*: POST, JSON, gateway ready, bounded body.
     *
     * @return the request body, or null if an error response has already been sent
     */
    private byte[] readJsonPost(final HttpExchange ex, final String method) throws IOException {
        if (!"POST".equals(method)) {
            sendError(ex, 405, "Use POST");
            return null;
        }
        var contentType = ex.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("application/json")) {
            sendError(ex, 415, "Content-Type must be application/json");
            return null;
        }
        if (!m_ready.getAsBoolean()) {
            // Calling a gateway service before the UI has injected its dependencies would create the singleton
            // without them and break KNIME's own UI initialisation, so refuse until the UI is up.
            ex.getResponseHeaders().set("Retry-After", "2");
            sendError(ex, 503, "KNIME UI not initialised yet");
            return null;
        }
        byte[] request;
        try (InputStream in = ex.getRequestBody()) {
            request = in.readNBytes(MAX_BODY_BYTES + 1);
        }
        if (request.length > MAX_BODY_BYTES) {
            sendError(ex, 413, "Request body too large");
            return null;
        }
        return request;
    }

    private void handleApi(final HttpExchange ex, final String method, final String path, final ApiHandler api)
        throws IOException {
        var request = readJsonPost(ex, method);
        if (request == null) {
            return;
        }
        var startNanos = System.nanoTime();
        try {
            var response = api.handle(request);
            m_log.info("knime-cli: API " + path + " -> 200 in " + (System.nanoTime() - startNanos) / 1_000_000 + " ms");
            send(ex, 200, response);
        } catch (ApiException e) {
            m_log.info("knime-cli: API " + path + " -> " + e.status() + " (" + e.getMessage() + ")");
            sendError(ex, e.status(), e.getMessage());
        } catch (Exception e) { // NOSONAR: report any gateway failure as a 500 rather than dropping the connection
            m_log.warn("knime-cli: API " + path + " failed", e);
            sendError(ex, 500, e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private void handleRpc(final HttpExchange ex, final String method) throws IOException {
        var request = readJsonPost(ex, method);
        if (request == null) {
            return;
        }
        var startNanos = System.nanoTime();
        var response = m_rpc.handle(request);
        m_log.info("knime-cli: RPC " + rpcMethod(request) + " -> " + rpcOutcome(response) + " in "
            + (System.nanoTime() - startNanos) / 1_000_000 + " ms");
        if (response == null || response.length == 0) {
            ex.sendResponseHeaders(204, -1); // JSON-RPC notification: no response body
            return;
        }
        send(ex, 200, response);
    }

    private record Rejection(int status, String message) {
    }

    private static final Pattern METHOD = Pattern.compile("\"method\"\\s*:\\s*\"([^\"]{1,200})\"");

    private static final Pattern ERROR = Pattern.compile("\"error\"\\s*:\\s*\\{[^}]*?\"message\"\\s*:\\s*\"([^\"]{0,200})");

    /** Best-effort method name for logging only; never used for dispatch. */
    private static String rpcMethod(final byte[] request) {
        var head = new String(request, 0, Math.min(request.length, 4096), StandardCharsets.UTF_8);
        var m = METHOD.matcher(head);
        return m.find() ? m.group(1) : "<unknown>";
    }

    /** "ok" or "error: <message>", for logging only. */
    private static String rpcOutcome(final byte[] response) {
        if (response == null || response.length == 0) {
            return "notification";
        }
        var head = new String(response, 0, Math.min(response.length, 4096), StandardCharsets.UTF_8);
        var m = ERROR.matcher(head);
        return m.find() ? "error: " + m.group(1) : "ok";
    }

    private Rejection checkRequest(final HttpExchange ex) {
        var headers = ex.getRequestHeaders();
        if (headers.containsKey("Origin")) {
            return new Rejection(403, "Browser requests are not allowed");
        }
        var host = headers.getFirst("Host");
        if (host == null || !isAllowedHost(host.toLowerCase(Locale.ROOT))) {
            return new Rejection(403, "Invalid Host header");
        }
        var auth = headers.getFirst("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")
            || !MessageDigest.isEqual(m_token, auth.substring(7).trim().getBytes(StandardCharsets.UTF_8))) {
            ex.getResponseHeaders().set("WWW-Authenticate", "Bearer");
            return new Rejection(401, "Missing or invalid bearer token");
        }
        return null;
    }

    private boolean isAllowedHost(final String host) {
        var port = ":" + getPort();
        return host.equals("127.0.0.1" + port) || host.equals("localhost" + port);
    }

    private static void sendError(final HttpExchange ex, final int status, final String message) throws IOException {
        sendJson(ex, status, Json.object(Map.of("error", message)));
    }

    private static void sendJson(final HttpExchange ex, final int status, final String json) throws IOException {
        send(ex, status, json.getBytes(StandardCharsets.UTF_8));
    }

    private static void send(final HttpExchange ex, final int status, final byte[] body) throws IOException {
        var h = ex.getResponseHeaders();
        h.set("Content-Type", "application/json; charset=utf-8");
        h.set("Cache-Control", "no-store");
        h.set("X-Content-Type-Options", "nosniff");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(body);
        }
    }
}
