package com.ben47203.knimecli.server;

import java.io.IOException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.knime.core.node.KNIMEConstants;
import org.knime.core.node.NodeLogger;
import org.knime.gateway.impl.webui.jsonrpc.DefaultJsonRpcRequestHandler;
import org.knime.gateway.impl.webui.service.ServiceInstances;

/**
 * Wires the {@link LocalApiServer} to KNIME's gateway and owns its start/stop.
 *
 * <p>
 * The gateway services are process-wide singletons ({@link ServiceInstances}). {@link DefaultJsonRpcRequestHandler}
 * resolves them lazily on each call, so our handler reaches the exact same instances (and so the same workflow
 * middleware, undo stacks and UI event consumer) as KNIME's own UI.
 */
final class ServerLifecycle {

    private static final NodeLogger LOGGER = NodeLogger.getLogger(ServerLifecycle.class);

    private static LocalApiServer server;

    private static DiscoveryFile discoveryFile;

    private static Thread shutdownHook;

    private ServerLifecycle() {
    }

    static synchronized void start() {
        if (server != null) {
            return;
        }
        try {
            var token = newToken();
            var pid = ProcessHandle.current().pid();
            var info = new LinkedHashMap<String, Object>();
            info.put("knimeVersion", KNIMEConstants.VERSION);
            info.put("pid", pid);

            var handler = new DefaultJsonRpcRequestHandler(); // services resolved lazily, safe before UI init
            var s = new LocalApiServer(new RpcAllowlist(handler::handle), routes(GatewayReadApi.endpoints()), //
                ServerLifecycle::isGatewayReady, info, token, new Log());
            s.start();

            var contents = new LinkedHashMap<String, Object>(info);
            contents.put("apiVersion", LocalApiServer.API_VERSION);
            contents.put("port", s.getPort());
            contents.put("url", "http://127.0.0.1:" + s.getPort());
            contents.put("token", token);
            contents.put("startedAt", Instant.now().toString());
            discoveryFile = DiscoveryFile.write(DiscoveryFile.defaultDirectory(), pid, contents);
            server = s;

            // Bundle stop isn't guaranteed on abnormal exit; the hook covers System.exit and SIGTERM.
            shutdownHook = new Thread(ServerLifecycle::cleanUpFromHook, "knime-cli-shutdown");
            Runtime.getRuntime().addShutdownHook(shutdownHook);
            LOGGER.info("knime-cli: discovery file " + discoveryFile.path());
        } catch (IOException | RuntimeException e) { // NOSONAR: never take KNIME down with us
            LOGGER.error("Failed to start knime-cli API server", e);
            stop();
        }
    }

    private static Map<String, LocalApiServer.ApiHandler> routes(final List<Endpoint<?>> endpoints) {
        // A plain loop: Eclipse's compiler can't infer the method-ref-returning lambda inside Collectors.toMap.
        var routes = new LinkedHashMap<String, LocalApiServer.ApiHandler>();
        for (var e : endpoints) {
            if (routes.put(e.path(), e::handle) != null) {
                throw new IllegalStateException("Duplicate route " + e.path());
            }
        }
        return routes;
    }

    static synchronized void stop() {
        if (shutdownHook != null) {
            try {
                Runtime.getRuntime().removeShutdownHook(shutdownHook);
            } catch (IllegalStateException e) { // NOSONAR: already shutting down
            }
            shutdownHook = null;
        }
        cleanUp();
    }

    private static synchronized void cleanUpFromHook() {
        shutdownHook = null;
        cleanUp();
    }

    private static void cleanUp() {
        if (discoveryFile != null) {
            discoveryFile.delete();
            discoveryFile = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    /**
     * The UI injects service dependencies and then makes its first RPC, which creates the service singletons. Until
     * then, touching a service would create it without dependencies and break the UI's own initialisation. This check
     * reads state only and never creates a service. It also turns false again when the UI suspends (services
     * disposed).
     *
     * <p>
     * Known race (acceptable for the spike): the UI could suspend between this check and our call.
     */
    private static boolean isGatewayReady() {
        var ready = ServiceInstances.areServicesInitialized();
        if (ready != lastReady) {
            lastReady = ready;
            LOGGER.info(ready ? "knime-cli: gateway ready, /rpc enabled" : "knime-cli: gateway not ready, /rpc paused");
        }
        return ready;
    }

    /** Only for logging readiness transitions; checked lazily on each request. */
    private static volatile boolean lastReady;

    private static String newToken() {
        var bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static final class Log implements LocalApiServer.Log {
        @Override
        public void info(final String msg) {
            LOGGER.info(msg);
        }

        @Override
        public void warn(final String msg, final Throwable t) {
            LOGGER.warn(msg, t);
        }
    }
}
