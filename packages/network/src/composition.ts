import { v4 as uuidv4 } from 'uuid'
import * as Protocol from 'streamr-client-protocol'
import { Metrics, MetricsContext } from './helpers/MetricsContext'
import { Location, TrackerInfo } from './identifiers'
import { PeerInfo } from './connection/PeerInfo'
import { HttpServerConfig, ServerWsEndpoint, startHttpServer } from './connection/ws/ServerWsEndpoint'
import { DEFAULT_MAX_NEIGHBOR_COUNT, TopologyStabilizationOptions, Tracker } from './logic/tracker/Tracker'
import { TrackerServer } from './protocol/TrackerServer'
import { trackerHttpEndpoints } from './logic/tracker/trackerHttpEndpoints'
import { NodeToTracker } from './protocol/NodeToTracker'
import { RtcSignaller } from './logic/node/RtcSignaller'
import { NodeToNode } from './protocol/NodeToNode'
import { NetworkNode } from './logic/node/NetworkNode'
import { Logger } from './helpers/Logger'
import { NameDirectory } from './NameDirectory'
import { NegotiatedProtocolVersions } from "./connection/NegotiatedProtocolVersions"
import NodeClientWsEndpoint from './connection/ws/NodeClientWsEndpoint'
import { WebRtcEndpoint } from './connection/WebRtcEndpoint'
import NodeWebRtcConnectionFactory from "./connection/NodeWebRtcConnection"
import { NodeId } from './logic/node/Node'

require('setimmediate')

export {
    Location,
    Metrics,
    MetricsContext,
    NetworkNode,
    Protocol,
    Tracker,
    Logger,
    NameDirectory
}

export interface AbstractNodeOptions {
    id?: NodeId
    name?: string
    location?: Location | null
    metricsContext?: MetricsContext
    trackerPingInterval?: number
}

export interface TrackerOptions extends AbstractNodeOptions {
    listen: HttpServerConfig
    attachHttpEndpoints?: boolean
    maxNeighborsPerNode?: number
    privateKeyFileName?: string
    certFileName?: string,
    topologyStabilization?: TopologyStabilizationOptions
}

export interface NetworkNodeOptions extends AbstractNodeOptions {
    trackers: TrackerInfo[],
    disconnectionWaitTime?: number,
    peerPingInterval?: number
    newWebrtcConnectionTimeout?: number,
    webrtcDatachannelBufferThresholdLow?: number,
    webrtcDatachannelBufferThresholdHigh?: number,
    webrtcDisallowPrivateAddresses?: boolean,
    stunUrls?: string[],
    rttUpdateTimeout?: number,
    trackerConnectionMaintenanceInterval?: number
}

export const startTracker = async ({
    listen,
    id = uuidv4(),
    name,
    location,
    attachHttpEndpoints = true,
    maxNeighborsPerNode = DEFAULT_MAX_NEIGHBOR_COUNT,
    metricsContext = new MetricsContext(id),
    trackerPingInterval,
    privateKeyFileName,
    certFileName,
    topologyStabilization
}: TrackerOptions): Promise<Tracker> => {
    const peerInfo = PeerInfo.newTracker(id, name, undefined, undefined, location)
    const httpServer = await startHttpServer(listen, privateKeyFileName, certFileName)
    const endpoint = new ServerWsEndpoint(listen, privateKeyFileName !== undefined, httpServer, peerInfo, metricsContext, trackerPingInterval)

    const tracker = new Tracker({
        peerInfo,
        protocols: {
            trackerServer: new TrackerServer(endpoint)
        },
        metricsContext,
        maxNeighborsPerNode,
        topologyStabilization
    })

    if (attachHttpEndpoints) {
        trackerHttpEndpoints(httpServer, tracker, metricsContext)
    }

    return tracker
}

export const createNetworkNode = ({
    id = uuidv4(),
    name,
    location,
    trackers,
    metricsContext = new MetricsContext(id),
    peerPingInterval,
    trackerPingInterval,
    disconnectionWaitTime,
    newWebrtcConnectionTimeout,
    rttUpdateTimeout,
    webrtcDatachannelBufferThresholdLow,
    webrtcDatachannelBufferThresholdHigh,
    webrtcDisallowPrivateAddresses = false,
    stunUrls = ['stun:stun.l.google.com:19302'],
    trackerConnectionMaintenanceInterval
}: NetworkNodeOptions): NetworkNode => {
    const peerInfo = PeerInfo.newNode(id, name, undefined, undefined, location)
    const endpoint = new NodeClientWsEndpoint(peerInfo, metricsContext, trackerPingInterval)
    const nodeToTracker = new NodeToTracker(endpoint)

    const webRtcSignaller = new RtcSignaller(peerInfo, nodeToTracker)
    const negotiatedProtocolVersions = new NegotiatedProtocolVersions(peerInfo)
    const nodeToNode = new NodeToNode(new WebRtcEndpoint(
        peerInfo,
        stunUrls,
        webRtcSignaller,
        metricsContext,
        negotiatedProtocolVersions,
        NodeWebRtcConnectionFactory,
        newWebrtcConnectionTimeout,
        peerPingInterval,
        webrtcDatachannelBufferThresholdLow,
        webrtcDatachannelBufferThresholdHigh,
        webrtcDisallowPrivateAddresses,
    ))

    return new NetworkNode({
        peerInfo,
        trackers,
        protocols: {
            nodeToTracker,
            nodeToNode
        },
        metricsContext,
        disconnectionWaitTime,
        rttUpdateTimeout,
        trackerConnectionMaintenanceInterval
    })
}
