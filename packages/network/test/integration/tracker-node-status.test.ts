import { Tracker } from '../../src/logic/tracker/Tracker'
import { NetworkNode } from '../../src/logic/node/NetworkNode'
import { wait, waitForEvent } from 'streamr-test-utils'

import { createNetworkNode, startTracker } from '../../src/composition'
import { Event as TrackerServerEvent } from '../../src/protocol/TrackerServer'
import { Event as NodeEvent } from '../../src/logic/node/Node'

/**
 * This test verifies that tracker receives status messages from nodes with list of neighbor connections
 */

// Seems to only be able to perform one connection on the tracker using the split ws client/server (???)
describe('check status message flow between tracker and two nodes', () => {
    let tracker: Tracker
    let nodeOne: NetworkNode
    let nodeTwo: NetworkNode
    const TRACKER_ID = 'tracker'
    const streamId = 'stream-1'
    const streamId2 = 'stream-2'

    const location = {
        country: 'FI',
        city: 'Helsinki',
        latitude: null,
        longitude: null
    }

    beforeEach(async () => {
        tracker = await startTracker({
            listen: {
                hostname: '127.0.0.1',
                port: 30750
            },
            id: TRACKER_ID
        })
        const trackerInfo = { id: 'tracker', ws: tracker.getUrl(), http: tracker.getUrl() }

        nodeOne = createNetworkNode({
            id: 'node-1',
            trackers: [trackerInfo],
            peerPingInterval: 100,
            trackerPingInterval: 100,
            rttUpdateTimeout: 10
        })
        
        nodeTwo = createNetworkNode({
            id: 'node-2',
            trackers: [trackerInfo],
            location,
            peerPingInterval: 100,
            trackerPingInterval: 100,
            rttUpdateTimeout: 10
        })
    })

    afterEach(async () => {
        await Promise.allSettled([
            nodeOne.stop(),
            nodeTwo.stop(),
            tracker.stop()
        ])
    })

    it('tracker should receive status message from node', (done) => {
        nodeOne.subscribe(streamId, 0)
        // @ts-expect-error private field
        tracker.trackerServer.once(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, peerInfo) => {
            expect(peerInfo).toEqual('node-1')
            done()
        })

        nodeOne.subscribe('stream-id', 0)
        nodeOne.start()
    })

    it('tracker should receive status from second node', (done) => {
        nodeTwo.subscribe(streamId, 0)
        // @ts-expect-error private field
        tracker.trackerServer.once(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, peerInfo) => {
            expect(peerInfo).toEqual('node-2')
            done()
        })

        nodeTwo.subscribe('stream-id', 0)
        nodeTwo.start()
    })

    it('tracker should receive from both nodes new statuses', (done) => {
        nodeOne.subscribe('stream-id', 0)
        nodeTwo.subscribe('stream-id', 0)
        nodeOne.start()
        nodeTwo.start()

        let receivedTotal = 0
        let nodeOneStatusReceived = false
        let nodeTwoStatusReceived = false

        // @ts-expect-error private field
        tracker.trackerServer.on(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, nodeId) => {
            if (nodeId === 'node-1' && !nodeOneStatusReceived) {
                nodeOneStatusReceived = true
                receivedTotal += 1
            }

            if (nodeId === 'node-2' && !nodeTwoStatusReceived) {
                nodeTwoStatusReceived = true
                receivedTotal += 1
            }

            if (receivedTotal === 2) {
                done()
            }
        })

        setTimeout(() => {
            nodeOne.subscribe(streamId, 0)
            nodeTwo.subscribe(streamId, 0)
        }, 100)
    })

    it('tracker should receive rtt values from nodes', () => {
        return new Promise(async (resolve) => {
            let receivedTotal = 0
            let nodeOneStatus: any = null
            let nodeTwoStatus: any = null

            await Promise.all([
                nodeOne.start(),
                nodeTwo.start()
            ])

            nodeOne.subscribe(streamId, 0)
            nodeTwo.subscribe(streamId, 0)

            await Promise.all([
                waitForEvent(nodeOne, NodeEvent.NODE_SUBSCRIBED),
                waitForEvent(nodeTwo, NodeEvent.NODE_SUBSCRIBED),
                wait(2000)
            ])

            // @ts-expect-error private field
            tracker.trackerServer.on(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, nodeId) => {
                if (nodeId === 'node-1') {
                    nodeOneStatus = statusMessage.status
                    receivedTotal += 1
                }

                if (nodeId === 'node-2') {
                    nodeTwoStatus = statusMessage.status
                    receivedTotal += 1
                }

                if (receivedTotal === 2) {
                    expect(nodeOneStatus.rtts['node-2']).toBeGreaterThanOrEqual(0)
                    expect(nodeTwoStatus.rtts['node-1']).toBeGreaterThanOrEqual(0)
                    resolve(true)
                }
            })
            nodeOne.subscribe(streamId2, 0)
            nodeTwo.subscribe(streamId2, 0)
        })
    })

    it('tracker should receive location information from nodes', (done) => {
        let receivedTotal = 0
        let nodeOneStatus: any = null
        let nodeTwoStatus: any = null

        nodeOne.start()
        nodeTwo.start()

        nodeOne.subscribe(streamId, 0)
        nodeTwo.subscribe(streamId, 0)

        // @ts-expect-error private field
        tracker.trackerServer.on(TrackerServerEvent.NODE_STATUS_RECEIVED, (statusMessage, nodeId) => {
            if (nodeId === nodeOne.getNodeId()) {
                nodeOneStatus = statusMessage.status
                // @ts-expect-error private field
                expect(tracker.locationManager.nodeLocations['node-1']).toBeUndefined()
            }

            if (nodeId === nodeTwo.getNodeId()) {
                nodeTwoStatus = statusMessage.status
                // @ts-expect-error private field
                expect(tracker.locationManager.nodeLocations['node-2'].country).toBe('FI')
            }
            receivedTotal += 1
            if (receivedTotal === 2) {
                expect(Object.keys(nodeOneStatus.location).length).toEqual(4)
                expect(Object.keys(nodeTwoStatus.location).length).toEqual(4)
                done()
            }
        })
    })
})
