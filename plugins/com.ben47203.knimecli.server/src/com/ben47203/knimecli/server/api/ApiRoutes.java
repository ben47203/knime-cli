package com.ben47203.knimecli.server.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.ben47203.knimecli.server.api.execution.ExecutionApi;
import com.ben47203.knimecli.server.api.settings.SettingsApi;
import com.ben47203.knimecli.server.api.workflow.GatewayReadApi;
import com.ben47203.knimecli.server.api.workflow.StatusApi;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiHandler;

/**
 * The {@code /api/*} routes, keyed by path. The entry point {@code http/} uses; the other public classes here are the
 * shared framework for the feature subpackages.
 */
public final class ApiRoutes {

    private ApiRoutes() {
    }

    /** All routes; fails fast if two endpoints claim the same path. */
    public static Map<String, ApiHandler> all() {
        var endpoints = new ArrayList<Endpoint<?>>(GatewayReadApi.endpoints());
        endpoints.addAll(StatusApi.endpoints());
        endpoints.addAll(ExecutionApi.endpoints());
        endpoints.addAll(SettingsApi.endpoints());
        return routes(endpoints);
    }

    private static Map<String, ApiHandler> routes(final List<Endpoint<?>> endpoints) {
        // A plain loop: Eclipse's compiler can't infer the method-ref-returning lambda inside Collectors.toMap.
        var routes = new LinkedHashMap<String, ApiHandler>();
        for (var e : endpoints) {
            if (routes.put(e.path(), e::handle) != null) {
                throw new IllegalStateException("Duplicate route " + e.path());
            }
        }
        return routes;
    }
}
