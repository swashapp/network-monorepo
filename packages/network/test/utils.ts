import { SPIDKey } from 'streamr-client-protocol'
import { MetricsContext, Tracker } from '../src/composition'
import { PeerInfo } from '../src/connection/PeerInfo'
import { ServerWsEndpoint, startHttpServer } from '../src/connection/ws/ServerWsEndpoint'
import { Node } from '../src/logic/node/Node'

export const startServerWsEndpoint = async (
    host: string,
    port: number,
    peerInfo: PeerInfo,
    metricsContext?: MetricsContext,
    pingInterval?: number | undefined
): Promise<ServerWsEndpoint> => {
    const listen = {
        hostname: host,
        port: port
    }
    const httpServer = await startHttpServer(listen, undefined, undefined)
    return  new ServerWsEndpoint(listen, false, httpServer, peerInfo, metricsContext, pingInterval)
}

export const getSPIDKeys = (nodeOrTracker: Node|Tracker): SPIDKey[] => {
    return Array.from(nodeOrTracker.getSPIDs(), (spid) => spid.toKey())
}