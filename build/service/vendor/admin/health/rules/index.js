import { appStopped, appRestarting, coreAppDown } from "./apps";
import { consensusWithoutExecution, executionWithoutConsensus, monitoringMissing, metricsUnavailable, monitoringStopped } from "./setup";
import { updatesAvailable, coreUpdateAvailable, autoupdateOff, storeUnreachable, updateBlocked } from "./updates";
import { feeRecipientMissing } from "./validators";
import { portsClosed, noUpnp, noNatLoopback, remoteAccessMissing } from "./access";
import { diskHigh } from "./storage";
import { diagnoseFailed } from "./core";
import { chainSyncing, chainError, headBehind, lowPeers, missedAttestations } from "./chain";

export const ALL_RULES = [
  appStopped, appRestarting, coreAppDown,
  consensusWithoutExecution, executionWithoutConsensus, monitoringMissing, metricsUnavailable, monitoringStopped,
  updatesAvailable, coreUpdateAvailable, autoupdateOff, storeUnreachable, updateBlocked,
  feeRecipientMissing,
  portsClosed, noUpnp, noNatLoopback, remoteAccessMissing,
  diskHigh, diagnoseFailed,
  chainSyncing, chainError, headBehind, lowPeers, missedAttestations,
];
