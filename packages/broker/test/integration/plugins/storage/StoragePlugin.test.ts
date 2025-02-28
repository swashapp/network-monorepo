import { MetricsContext, Protocol } from 'streamr-network'
import { StoragePlugin } from '../../../../src/plugins/storage/StoragePlugin'
import { StorageConfig } from '../../../../src/plugins/storage/StorageConfig'
import { STREAMR_DOCKER_DEV_HOST } from '../../../utils'
import { createMockStorageConfig } from './MockStorageConfig'
import { StorageNodeRegistry } from "../../../../src/StorageNodeRegistry"
import { Wallet } from 'ethers'

const SPIDS: Protocol.SPID[] = [new Protocol.SPID('foo', 0), new Protocol.SPID('bar', 0)]

const createMockPlugin = (networkNode: any, subscriptionManager: any) => {
    const wallet = Wallet.createRandom()
    const brokerConfig: any = {
        ethereumPrivateKey: wallet.privateKey,
        plugins: {
            storage: {
                cassandra: {
                    hosts: [
                        STREAMR_DOCKER_DEV_HOST
                    ],
                    username: '',
                    password: '',
                    keyspace: 'streamr_dev_v2',
                    datacenter: 'datacenter1'
                },
                storageConfig: {
                    refreshInterval: 0
                }
            }
        }
    }
    return new StoragePlugin({
        name: 'storage',
        networkNode,
        subscriptionManager,
        publisher: undefined as any,
        streamrClient: undefined as any,
        apiAuthenticator: undefined as any,
        metricsContext: new MetricsContext(null as any),
        brokerConfig,
        storageNodeRegistry: StorageNodeRegistry.createInstance(brokerConfig, []),
        nodeId: wallet.address
    })
}

describe('StoragePlugin', () => {

    let networkNode: any
    let subscriptionManager: any
    let storageConfig: any
    let storageConfigFactory: any

    beforeEach(() => {
        networkNode = {
            addMessageListener: jest.fn(),
            removeMessageListener: jest.fn(),
            subscribe: jest.fn()
        }
        subscriptionManager = {
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        }
        storageConfig = createMockStorageConfig(SPIDS)
        storageConfigFactory = jest.spyOn(StorageConfig, 'createInstance')
        storageConfigFactory.mockResolvedValue(storageConfig)
    })

    afterEach(() => {
        storageConfigFactory.mockRestore()
    })

    test('happy path: start and stop', async () => {
        const plugin = createMockPlugin(networkNode, subscriptionManager)
        await plugin.start()
        expect(subscriptionManager.subscribe).toBeCalledTimes(SPIDS.length)
        expect(networkNode.addMessageListener).toBeCalledTimes(1)
        expect(storageConfig.startAssignmentEventListener).toBeCalledTimes(1)
        // @ts-expect-error private field
        const cassandraClose = jest.spyOn(plugin.cassandra!, 'close')
        await plugin.stop()
        expect(subscriptionManager.unsubscribe).toBeCalledTimes(SPIDS.length)
        expect(networkNode.removeMessageListener).toBeCalledTimes(1)
        expect(storageConfig.stopAssignmentEventListener).toBeCalledTimes(1)
        expect(storageConfig.cleanup).toBeCalledTimes(1)
        expect(cassandraClose).toBeCalledTimes(1)
    }, 10 * 1000)
})
