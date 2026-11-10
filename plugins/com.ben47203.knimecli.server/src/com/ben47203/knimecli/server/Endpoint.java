package com.ben47203.knimecli.server;

import org.knime.gateway.json.util.ObjectMapperUtil;

import com.ben47203.knimecli.server.LocalApiServer.ApiException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.fasterxml.jackson.databind.exc.ValueInstantiationException;

/**
 * One {@code POST /api/...} route: a typed request record in, any Jackson-serialisable object out.
 *
 * <p>
 * Template method: {@link #handle(byte[])} parses and validates the request, then calls {@link #run(Object)}.
 * Subclasses such as {@link WorkflowEndpoint} add one resolution step each, so a concrete endpoint only implements
 * its own logic. Request records validate themselves in their compact constructors by throwing
 * {@link IllegalArgumentException}, which becomes a 400.
 *
 * @param <Q> request type, usually a record
 */
abstract class Endpoint<Q> {

    /** What a route can do; lets clients (and later the server) restrict agents to reads. */
    enum Tier {
            /** No changes to workflows, settings or files. */
            READ,
            /** Changes workflows, settings or files. */
            WRITE,
            /** Starts, cancels or resets execution. */
            EXEC
    }

    /** Strict on purpose: an unknown field is almost always a typo that would otherwise be silently ignored. */
    private static final ObjectMapper REQUEST_MAPPER = new ObjectMapper() //
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
            DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    /** The gateway's mapper, so gateway entities serialise exactly as the UI sees them. */
    static final ObjectMapper RESPONSE_MAPPER = ObjectMapperUtil.getInstance().getObjectMapper();

    private final String m_path;

    private final Tier m_tier;

    private final Class<Q> m_requestType;

    /**
     * @param path route path without the {@code /api/} prefix, e.g. {@code workflow/state}
     */
    Endpoint(final String path, final Tier tier, final Class<Q> requestType) {
        m_path = "/api/" + path;
        m_tier = tier;
        m_requestType = requestType;
    }

    final String path() {
        return m_path;
    }

    final Tier tier() {
        return m_tier;
    }

    /** Entry point for {@link LocalApiServer.ApiHandler}. */
    final byte[] handle(final byte[] body) throws Exception {
        return RESPONSE_MAPPER.writeValueAsBytes(run(parse(body)));
    }

    /** Runs the endpoint for a parsed, validated request; throw {@link ApiException} for non-500 failures. */
    abstract Object run(Q request) throws Exception; // NOSONAR: failures become 500s in one place

    private Q parse(final byte[] body) throws ApiException {
        try {
            var request = REQUEST_MAPPER.readValue(body, m_requestType);
            if (request == null) {
                throw new ApiException(400, "Request body must be a JSON object");
            }
            return request;
        } catch (ValueInstantiationException e) { // thrown by a record's compact constructor
            var cause = e.getCause();
            throw new ApiException(400, cause != null ? cause.getMessage() : e.getOriginalMessage());
        } catch (UnrecognizedPropertyException e) {
            throw new ApiException(400,
                "Unknown field '" + e.getPropertyName() + "'; allowed: " + e.getKnownPropertyIds());
        } catch (JsonProcessingException e) {
            throw new ApiException(400, "Invalid request: " + e.getOriginalMessage());
        } catch (java.io.IOException e) { // NOSONAR: reading from a byte array, can't really happen
            throw new ApiException(400, "Unreadable request body");
        }
    }

    /** Request with no fields; send {@code {}}. */
    record NoArgs() {
    }
}
