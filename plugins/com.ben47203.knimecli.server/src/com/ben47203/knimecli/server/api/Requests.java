package com.ben47203.knimecli.server.api;

import org.knime.gateway.api.entity.NodeIDEnt;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/** Validation helpers for request records. Compact constructors throw {@link IllegalArgumentException} (→ 400). */
final class Requests {

    private Requests() {
    }

    static void require(final Object value, final String field) {
        if (value == null || (value instanceof String s && s.isBlank())) {
            throw new IllegalArgumentException(field + " is required");
        }
    }

    /** Parses a gateway node id such as {@code root:3} or {@code root:5:0:2}. */
    static NodeIDEnt nodeIdEnt(final String id, final String field) throws ApiException {
        try {
            return new NodeIDEnt(id);
        } catch (RuntimeException e) { // NOSONAR: any parse failure is a client error
            throw new ApiException(400, "Invalid " + field + ": " + id);
        }
    }
}
