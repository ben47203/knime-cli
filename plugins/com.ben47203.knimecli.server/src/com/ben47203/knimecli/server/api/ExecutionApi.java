package com.ben47203.knimecli.server.api;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.NodeID;
import org.knime.core.node.workflow.NodeMessage;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;
import com.ben47203.knimecli.server.api.NodeStates.Message;
import com.ben47203.knimecli.server.api.NodeStates.State;
import com.ben47203.knimecli.server.api.WorkflowEndpoint.WorkflowRef;

/**
 * Execution control, on core {@link WorkflowManager} calls only. The gateway's {@code changeNodeStates} is
 * deliberately not used: it is one RPC away from snapshot-committing services, and we need our own waiting anyway.
 *
 * <p>
 * Execution in KNIME is asynchronous: {@code executeUpToHere}/{@code executeAll} mark nodes under the workflow lock
 * and return. {@code waitMs} turns that into a bounded long-poll on the HTTP worker thread (never the SWT thread),
 * sleeping without holding any lock.
 */
final class ExecutionApi {

    /** Upper bound for {@code waitMs}, so a waiting client can't hold a worker thread indefinitely. */
    static final int MAX_WAIT_MS = 30_000;

    /** Poll interval while waiting; short enough to feel immediate, long enough to be free. */
    private static final long POLL_MS = 100;

    private ExecutionApi() {
    }

    static List<Endpoint<?>> endpoints() {
        return List.of(new Execute(), new Wait(), new Cancel(), new Reset());
    }

    /** Nodes to act on in one workflow; omit {@code nodeIds} to act on the whole workflow. */
    record NodesRequest(String projectId, String workflowId, List<String> nodeIds) implements WorkflowRef {
        NodesRequest {
            Requests.require(projectId, "projectId");
            nodeIds = Requests.optionalIds(nodeIds, "nodeIds");
        }
    }

    /** As {@link NodesRequest}, plus how long to wait for the nodes to finish (0 = don't wait). */
    record WaitRequest(String projectId, String workflowId, List<String> nodeIds, Integer waitMs)
        implements WorkflowRef {
        WaitRequest {
            Requests.require(projectId, "projectId");
            nodeIds = Requests.optionalIds(nodeIds, "nodeIds");
            if (waitMs == null) {
                waitMs = 0;
            } else if (waitMs < 0 || waitMs > MAX_WAIT_MS) {
                throw new IllegalArgumentException("waitMs must be between 0 and " + MAX_WAIT_MS);
            }
        }
    }

    /** A node that ended in an error, with the message the UI shows. */
    record Failure(String nodeId, String name, Message message) {
    }

    /**
     * Outcome of execute/wait. {@code done} is false if any target is still queued or executing (timeout); then call
     * {@code wait} again. {@code failed} covers the targets and their predecessors, since an upstream failure is
     * usually why a target didn't run.
     */
    record ExecResult(boolean done, Map<String, State> states, List<Failure> failed) {
    }

    /**
     * {@code POST /api/execute}: executes the given nodes (and their not-yet-executed predecessors), or the whole
     * workflow, then optionally waits.
     */
    static final class Execute extends WorkflowEndpoint<WaitRequest> {
        Execute() {
            super("execute", Tier.EXEC, WaitRequest.class);
        }

        @Override
        Object execute(final WorkflowManager wfm, final WaitRequest request) throws ApiException {
            var targets = targets(wfm, request.nodeIds());
            if (request.nodeIds() == null) {
                wfm.executeAll();
            } else {
                wfm.executeUpToHere(targets.stream().map(NodeContainer::getID).toArray(NodeID[]::new));
            }
            return await(wfm, targets, request.nodeIds() != null, request.waitMs());
        }
    }

    /** {@code POST /api/wait}: as {@link Execute} without starting anything, e.g. to keep waiting after a timeout. */
    static final class Wait extends WorkflowEndpoint<WaitRequest> {
        Wait() {
            super("wait", Tier.READ, WaitRequest.class);
        }

        @Override
        Object execute(final WorkflowManager wfm, final WaitRequest request) throws ApiException {
            return await(wfm, targets(wfm, request.nodeIds()), request.nodeIds() != null, request.waitMs());
        }
    }

    /**
     * {@code POST /api/cancel}: cancels the given nodes, or everything in the workflow. Cancelling is asynchronous, so
     * nodes may still report EXECUTING; follow up with {@code wait}.
     */
    static final class Cancel extends WorkflowEndpoint<NodesRequest> {
        Cancel() {
            super("cancel", Tier.EXEC, NodesRequest.class);
        }

        @Override
        Object execute(final WorkflowManager wfm, final NodesRequest request) throws ApiException {
            var targets = targets(wfm, request.nodeIds());
            if (request.nodeIds() == null) {
                wfm.cancelExecution();
            } else {
                targets.forEach(wfm::cancelExecution);
            }
            return Map.of("states", states(targets));
        }
    }

    /**
     * {@code POST /api/reset}: resets and reconfigures the given nodes (and their successors), or the whole workflow.
     * Nodes that never ran are skipped, so resetting is idempotent. 409 if a node is busy (or has busy successors),
     * rather than resetting some and not others.
     */
    static final class Reset extends WorkflowEndpoint<NodesRequest> {
        Reset() {
            super("reset", Tier.EXEC, NodesRequest.class);
        }

        @Override
        @SuppressWarnings("try") // the lock is held, not used
        Object execute(final WorkflowManager wfm, final NodesRequest request) throws ApiException {
            var targets = targets(wfm, request.nodeIds());
            // Check and reset under one lock hold, so nothing can start executing in between.
            try (var lock = wfm.lock()) {
                if (request.nodeIds() == null) {
                    resetAll(wfm, targets);
                } else {
                    var resettable = targets.stream().filter(nc -> wfm.canResetNode(nc.getID())).toList();
                    var blocked = targets.stream().filter(nc -> !resettable.contains(nc) && !neverRun(nc))
                        .map(nc -> NodeIds.toId(nc) + " " + whyNotResettable(nc)).toList();
                    if (!blocked.isEmpty()) {
                        throw new ApiException(409, "Cannot reset: " + String.join("; ", blocked));
                    }
                    resettable.forEach(nc -> wfm.resetAndConfigureNode(nc.getID()));
                }
            }
            return Map.of("states", states(targets));
        }

        /** Same approach as the UI's "reset all": every resettable node, fully resetting metanodes. */
        private static void resetAll(final WorkflowManager wfm, final List<NodeContainer> nodes) throws ApiException {
            var busy = nodes.stream().filter(NodeStates::inProgress).map(NodeIds::toId).toList();
            if (!busy.isEmpty()) {
                throw new ApiException(409, "Cannot reset while nodes are queued or executing: "
                    + String.join(", ", busy) + "; cancel them first");
            }
            for (var nc : nodes) {
                // Checked per node: resetting an upstream node already resets its successors.
                if (wfm.canResetNode(nc.getID())) {
                    wfm.resetAndConfigureNode(nc.getID(), true);
                }
            }
        }

        /**
         * Already in the state a reset would leave it in, so it's skipped rather than rejected: callers can reset
         * idempotently. Its successors can't be running either, since they'd have no input.
         */
        private static boolean neverRun(final NodeContainer nc) {
            var state = NodeStates.state(nc);
            return state == State.IDLE || state == State.CONFIGURED;
        }

        private static String whyNotResettable(final NodeContainer nc) {
            if (NodeStates.inProgress(nc)) {
                return "is " + NodeStates.state(nc) + "; cancel it first";
            }
            return "has successors that are queued or executing; cancel or wait for them first";
        }
    }

    /** The addressed nodes, or every node directly in the workflow when {@code nodeIds} was omitted. */
    private static List<NodeContainer> targets(final WorkflowManager wfm, final List<String> nodeIds)
        throws ApiException {
        if (nodeIds == null) {
            return NodeStates.children(wfm);
        }
        var targets = new ArrayList<NodeContainer>(nodeIds.size());
        for (var id : nodeIds) {
            targets.add(NodeEndpoint.resolveNode(wfm, id, "nodeIds"));
        }
        return targets;
    }

    /**
     * Polls until no target is queued or executing, or {@code waitMs} runs out. Sleeps without holding any lock, and
     * returns early (not done) if the worker is interrupted, e.g. on server stop.
     */
    private static ExecResult await(final WorkflowManager wfm, final List<NodeContainer> targets,
        final boolean selected, final int waitMs) {
        // Computed up front: the graph walk takes the lock, which we don't want to do on every poll.
        var scope = selected ? withPredecessors(wfm, targets) : targets;
        var deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs);
        var done = targets.stream().noneMatch(NodeStates::inProgress);
        while (!done) {
            var leftMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (leftMs <= 0) {
                break;
            }
            try {
                Thread.sleep(Math.min(POLL_MS, leftMs));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            done = targets.stream().noneMatch(NodeStates::inProgress);
        }
        var failed = scope.stream().filter(nc -> nc.getNodeMessage().getMessageType() == NodeMessage.Type.ERROR)
            .map(nc -> new Failure(NodeIds.toId(nc), nc.getName(), NodeStates.message(nc))).toList();
        return new ExecResult(done, states(targets), failed);
    }

    /** The targets plus everything upstream of them in this workflow (not across metanode/component borders). */
    @SuppressWarnings("try") // the lock is held, not used
    private static List<NodeContainer> withPredecessors(final WorkflowManager wfm, final List<NodeContainer> targets) {
        var seen = new LinkedHashSet<NodeID>();
        var queue = new ArrayDeque<NodeID>();
        targets.forEach(nc -> queue.add(nc.getID()));
        var result = new ArrayList<NodeContainer>();
        try (var lock = wfm.lock()) {
            while (!queue.isEmpty()) {
                var id = queue.poll();
                if (!seen.add(id)) {
                    continue;
                }
                var nc = wfm.tryGetNodeContainer(id);
                if (nc.isEmpty()) { // removed since the request was resolved
                    continue;
                }
                result.add(nc.get());
                for (var cc : wfm.getIncomingConnectionsFor(id)) {
                    if (!cc.getSource().equals(wfm.getID())) { // skip the metanode's own inports
                        queue.add(cc.getSource());
                    }
                }
            }
        }
        return result;
    }

    private static Map<String, State> states(final List<NodeContainer> nodes) {
        var states = new LinkedHashMap<String, State>();
        nodes.forEach(nc -> states.put(NodeIds.toId(nc), NodeStates.state(nc)));
        return states;
    }
}
