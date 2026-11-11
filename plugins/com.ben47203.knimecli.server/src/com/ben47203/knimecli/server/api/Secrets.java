package com.ben47203.knimecli.server.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import org.knime.core.node.config.base.AbstractConfigEntry;
import org.knime.core.node.config.base.ConfigBase;
import org.knime.core.node.config.base.ConfigBaseRO;
import org.knime.core.node.config.base.ConfigEntries;
import org.knime.core.node.config.base.ConfigStringEntry;

/**
 * Where passwords and credentials live in node settings, so the API can redact them on the way out and refuse to
 * change them on the way in.
 *
 * <p>
 * Only entry types, keys and the settings-model markers next to them are inspected. Nothing here decrypts or reads a
 * secret's value ({@code getPassword}, {@code getTransientString}): a value we never read is a value we can't leak.
 *
 * <p>
 * Detection is best effort. Modern settings mark secrets by entry type or by a settings-model id, which is reliable;
 * legacy nodes often store a {@code KnimeEncryption}-encrypted password as a plain string under a generic key, which
 * only the key-name heuristic (rule 4 of {@link #isSecret}) can catch, and not always.
 */
final class Secrets {

    /** Suffix of the sibling config in which a {@code SettingsModel} records its id and enabled state. */
    static final String INTERNALS_SUFFIX = "_Internals";

    private static final String SETTINGS_MODEL_ID = "SettingsModelID";

    /** {@code SettingsModelPassword}: the key itself holds the (encrypted) password. */
    private static final String SMID_PASSWORD = "SMID_password";

    /** {@code SettingsModelAuthentication}: the key is a config holding user name, password and auth type. */
    private static final String SMID_AUTHENTICATION = "SMID_authentication";

    /** Marker key of the modern Credentials widget's config; every other key in it is secret by default. */
    private static final String CREDENTIALS_MARKER = "isCredentials_Internals";

    /** Keys of a Credentials widget config that are safe to show and change. */
    private static final Set<String> CREDENTIALS_PUBLIC_KEYS = Set.of("login", "name", CREDENTIALS_MARKER);

    /** Leaf key names that suggest a secret; matched anywhere in the key, ignoring case. */
    private static final Pattern SECRET_NAME = Pattern.compile(
        "password|passwd|pwd|secret|token|apikey|api_key|private_?key|passphrase|weaklyencrypted|transient",
        Pattern.CASE_INSENSITIVE);

    /** Keys that match {@link #SECRET_NAME} loosely but hold the name of a credentials flow variable, not a secret. */
    private static final Set<String> CREDENTIAL_NAME_KEYS =
        Set.of("credentials", "credential_name", "credentialName", "name");

    private Secrets() {
    }

    /**
     * Whether the entry {@code key} of {@code parent} holds a secret and must be redacted. True if any of:
     * <ol>
     * <li>its type is {@code xpassword} or {@code xtransientstring};</li>
     * <li>its {@code <key>_Internals} sibling marks it as a {@code SettingsModelPassword};</li>
     * <li>{@code parent} is a Credentials widget config and {@code key} isn't one of its public keys;</li>
     * <li>it is a leaf whose name looks like a secret's (best effort, see the class comment), unless the name is one
     * used for credentials flow-variable names.</li>
     * </ol>
     * False if there is no such entry.
     */
    static boolean isSecret(final ConfigBaseRO parent, final String key) {
        var entry = entry(parent, key);
        if (entry == null) {
            return false;
        }
        var type = entry.getType();
        if (type == ConfigEntries.xpassword || type == ConfigEntries.xtransientstring) {
            return true;
        }
        if (SMID_PASSWORD.equals(settingsModelId(parent, key))) {
            return true;
        }
        if (parent.containsKey(CREDENTIALS_MARKER) && !CREDENTIALS_PUBLIC_KEYS.contains(key)) {
            return true;
        }
        return type != ConfigEntries.config && !CREDENTIAL_NAME_KEYS.contains(key)
            && SECRET_NAME.matcher(key).find();
    }

    /**
     * Whether {@code key} is a {@code SettingsModelAuthentication} or Credentials widget config. Their password
     * children are caught by {@link #isSecret} on their own, but the configs as a whole are also off limits: switching
     * the authentication type, user name or credentials variable could redirect a stored password to somewhere it
     * was never meant to go.
     */
    static boolean isProtectedConfig(final ConfigBaseRO parent, final String key) {
        return SMID_AUTHENTICATION.equals(settingsModelId(parent, key))
            || (entry(parent, key) instanceof ConfigBase config && config.containsKey(CREDENTIALS_MARKER));
    }

    /**
     * Whether {@code key} must not be changed field by field: it is a secret, a protected config, or a settings
     * model's {@code _Internals} config (rewriting a {@code SettingsModelID} would defeat the detection above).
     * Unlike {@link #isWriteProtected} this doesn't look inside configs, so a config that merely contains a secret
     * can still be patched key by key, with each key checked on its own.
     */
    static boolean isLocked(final ConfigBaseRO parent, final String key) {
        return key.endsWith(INTERNALS_SUFFIX) || isSecret(parent, key) || isProtectedConfig(parent, key);
    }

    /**
     * Whether {@code key} must not be replaced as a whole: {@link #isLocked}, or a config that contains a secret or
     * a protected config at any depth, so that replacing a subtree can't overwrite the secrets inside it.
     */
    static boolean isWriteProtected(final ConfigBaseRO parent, final String key) {
        return isLocked(parent, key) || (entry(parent, key) instanceof ConfigBase child && containsSecret(child));
    }

    /**
     * Every secret leaf under {@code root}, keyed by JSON Pointer relative to it. A secret config contributes all of
     * its leaves. Leaf entries are immutable, so the snapshot stays valid while {@code root} is changed; compare it
     * with {@link #sameSecrets(Map, ConfigBaseRO)}. The entries are for comparison only: never read their values.
     */
    static Map<String, AbstractConfigEntry> snapshot(final ConfigBaseRO root) {
        var secrets = new LinkedHashMap<String, AbstractConfigEntry>();
        collect(root, "", false, secrets);
        return secrets;
    }

    /**
     * Whether {@code after} holds exactly the secrets of {@code before}: same paths, types and (still encrypted)
     * values. Used to check that loading patched settings into a node didn't change or drop a secret.
     */
    static boolean sameSecrets(final ConfigBaseRO before, final ConfigBaseRO after) {
        return sameSecrets(snapshot(before), after);
    }

    /** As {@link #sameSecrets(ConfigBaseRO, ConfigBaseRO)}, against a {@link #snapshot} taken earlier. */
    static boolean sameSecrets(final Map<String, AbstractConfigEntry> before, final ConfigBaseRO after) {
        // AbstractConfigEntry.equals compares class, key and value via isIdentical, without exposing the value.
        return before.equals(snapshot(after));
    }

    /**
     * The entry {@code key} of {@code parent}, or null. {@link ConfigBaseRO} has no entry accessor, but every
     * implementation (NodeSettings, Config, ModelContent, ...) is a {@link ConfigBase}.
     */
    static AbstractConfigEntry entry(final ConfigBaseRO parent, final String key) {
        if (parent instanceof ConfigBase config) {
            return config.getEntry(key);
        }
        throw new IllegalArgumentException("Unsupported settings type " + parent.getClass().getName());
    }

    /** The {@code SettingsModelID} recorded in the {@code <key>_Internals} sibling, or null if there isn't one. */
    private static String settingsModelId(final ConfigBaseRO parent, final String key) {
        if (entry(parent, key + INTERNALS_SUFFIX) instanceof ConfigBase internals
            && internals.getEntry(SETTINGS_MODEL_ID) instanceof ConfigStringEntry id) {
            return id.getString();
        }
        return null; // NOSONAR: null means "not a settings model"
    }

    private static boolean containsSecret(final ConfigBase config) {
        for (var key : config) {
            if (isSecret(config, key) || isProtectedConfig(config, key)
                || (config.getEntry(key) instanceof ConfigBase child && containsSecret(child))) {
                return true;
            }
        }
        return false;
    }

    /** Adds the secret leaves of {@code config} to {@code secrets}; {@code inSecret} means all of its leaves are. */
    private static void collect(final ConfigBaseRO config, final String path, final boolean inSecret,
        final Map<String, AbstractConfigEntry> secrets) {
        for (var key : config) {
            var entry = entry(config, key);
            var childPath = SettingsJson.child(path, key);
            var secret = inSecret || isSecret(config, key);
            if (entry instanceof ConfigBase child) {
                collect(child, childPath, secret, secrets);
            } else if (secret) {
                secrets.put(childPath, entry);
            }
        }
    }
}
