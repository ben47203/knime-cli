package com.ben47203.knimecli.server.api;

import java.lang.reflect.AccessibleObject;

import org.knime.core.node.NodeLogger;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/**
 * A KNIME internal reached by reflection: a non-public method, or a class in a package its bundle doesn't export. Looked
 * up once, when the owning class initialises, so a KNIME upgrade that moves or renames it shows up at server start in
 * {@code /status} (see {@link Capabilities}) rather than as a failure halfway through a request.
 *
 * @param <T> the reflective handle, usually a {@link java.lang.reflect.Method}
 */
public final class Reflected<T extends AccessibleObject> {

    private static final NodeLogger LOGGER = NodeLogger.getLogger(Reflected.class);

    /** Looks the target up; may throw anything, which makes the target unavailable. */
    @FunctionalInterface
    public interface Lookup<T> {
        T find() throws Exception; // NOSONAR: any failure means "unavailable"
    }

    private final String m_description;

    private final T m_target;

    private final String m_problem;

    private Reflected(final String description, final T target, final String problem) {
        m_description = description;
        m_target = target;
        m_problem = problem;
    }

    /**
     * Looks {@code lookup}'s target up and makes it accessible.
     *
     * @param description what it is, e.g. {@code NodeModel.saveSettingsTo}, for messages
     * @param consequence what stops working without it, logged once
     */
    public static <T extends AccessibleObject> Reflected<T> find(final String description, final String consequence,
        final Lookup<T> lookup) {
        try {
            var target = lookup.find();
            target.setAccessible(true); // NOSONAR: the point of this class
            return new Reflected<>(description, target, null);
        } catch (Exception | LinkageError e) { // NOSONAR: degrade the one feature, never fail start-up
            var problem = "Can't reach " + description + " in this KNIME version (" + e.getClass().getSimpleName()
                + (e.getMessage() == null ? "" : ": " + e.getMessage()) + ")";
            LOGGER.warn("knime-cli: " + problem + ", so " + consequence, e);
            return new Reflected<>(description, null, problem);
        }
    }

    public boolean available() {
        return m_target != null;
    }

    /** Why the target is unavailable; null if it is available. */
    public String problem() {
        return m_problem;
    }

    /** The target, or null if unavailable; for best-effort callers that carry on without it. */
    public T orNull() {
        return m_target;
    }

    /** The target, or a 501 explaining why it's unavailable; for endpoints that can't work without it. */
    public T require() throws ApiException {
        if (m_target == null) {
            throw new ApiException(501, m_problem);
        }
        return m_target;
    }

    @Override
    public String toString() {
        return m_description + (available() ? "" : " (unavailable)");
    }
}
