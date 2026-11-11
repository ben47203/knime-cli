package com.ben47203.knimecli.server.api;

import java.util.List;

import org.knime.gateway.api.entity.NodeIDEnt;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/** Validation helpers for request records. Compact constructors throw {@link IllegalArgumentException} (→ 400). */
public final class Requests {

    private Requests() {
    }

    public static void require(final Object value, final String field) {
        if (value == null || (value instanceof String s && s.isBlank())) {
            throw new IllegalArgumentException(field + " is required");
        }
    }

    /**
     * An optional, non-empty list of ids. An empty list is rejected rather than read as "all": the caller most likely
     * meant to select something, and acting on the whole workflow by accident is the worse failure.
     */
    public static List<String> optionalIds(final List<String> ids, final String field) {
        if (ids == null) {
            return null; // NOSONAR: null means "not given", i.e. the whole workflow
        }
        if (ids.isEmpty()) {
            throw new IllegalArgumentException(field + " must not be empty; omit it to target the whole workflow");
        }
        for (var id : ids) {
            require(id, field + " entry");
        }
        return List.copyOf(ids);
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
