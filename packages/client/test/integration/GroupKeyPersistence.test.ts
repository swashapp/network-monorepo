import { describeRepeats, getCreateClient, fakePrivateKey, getPublishTestStreamMessages, createTestStream } from '../utils'
import { StreamrClient } from '../../src/StreamrClient'
import { Stream, StreamOperation } from '../../src/Stream'
import { GroupKey } from '../../src/encryption/Encryption'
import { StorageNode } from '../../src/StorageNode'

const TIMEOUT = 20 * 1000

describeRepeats('Group Key Persistence', () => {
    let publisher: StreamrClient
    let subscriber: StreamrClient
    let publishTestMessages: ReturnType<typeof getPublishTestStreamMessages>

    const createClient = getCreateClient()

    let publisherPrivateKey: string
    let subscriberPrivateKey: string

    describe('with requireEncryptedData true', () => {
        let stream: Stream

        async function setupPublisher(opts?: any, streamOpts: any = {}) {
            const client = createClient(opts)
            await Promise.all([
                client.getSessionToken(),
                client.connect(),
            ])

            stream = await createTestStream(client, module, {
                requireEncryptedData: true,
                ...streamOpts,
            })

            publishTestMessages = getPublishTestStreamMessages(client, stream)
            return client
        }

        beforeEach(async () => {
            publisherPrivateKey = fakePrivateKey()
            publisher = await setupPublisher({
                id: 'publisher',
                auth: {
                    privateKey: publisherPrivateKey,
                }
            })
            subscriberPrivateKey = fakePrivateKey()
            subscriber = createClient({
                id: 'subscriber',
                autoConnect: true,
                autoDisconnect: true,
                auth: {
                    privateKey: subscriberPrivateKey,
                }
            })
            const otherUser = await subscriber.getUserInfo()
            await stream.grantPermission(StreamOperation.STREAM_GET, otherUser.username)
            await stream.grantPermission(StreamOperation.STREAM_SUBSCRIBE, otherUser.username)
            const groupKey = GroupKey.generate()
            await publisher.setNextGroupKey(stream.id, groupKey)
        })

        describe('publisher persists group key, can keep serving group key requests (resend)', () => {
            let published: any[]
            let publisher2: StreamrClient
            beforeEach(async () => {
                // ensure publisher can read a persisted group key
                // 1. publish some messages with publisher
                // 2. then disconnect publisher
                // 3. create new publisher with same key
                // 4. resend messages with subscriber
                // because original publisher is disconnected
                // subscriber will need to ask new publisher
                // for group keys, which the new publisher will have to read from
                // persistence
                await stream.addToStorageNode(StorageNode.STREAMR_DOCKER_DEV)
                published = await publishTestMessages(5, {
                    waitForLast: true,
                })

                await publisher.destroy()
                publisher2 = createClient({
                    id: 'publisher2',
                    auth: {
                        privateKey: publisherPrivateKey,
                    }
                })

                await publisher2.connect()
            }, 2 * TIMEOUT)

            it('works', async () => {
                // TODO: this should probably happen automatically if there are keys
                // also probably needs to create a connection handle
                await publisher2.publisher.startKeyExchange()

                const received = []
                const sub = await subscriber.resend({
                    stream: stream.id,
                    last: published.length
                })

                for await (const m of sub) {
                    received.push(m)
                    if (received.length === published.length) {
                        break
                    }
                }

                expect(received).toEqual(published)
            }, 2 * TIMEOUT)
        })

        it('subscriber persists group key with realtime', async () => {
            // we want to check that subscriber can read a group key
            // persisted by another subscriber:
            // 1. create publisher and subscriber
            // 2. after subscriber gets first message disconnect subscriber
            // 3. create a new subscriber with same key as original subscriber
            // 5. and subscribe to same stream.
            // this should pick up group key persisted by first subscriber
            const sub = await subscriber.subscribe({
                stream: stream.id,
            })

            // this will be called if group key request is sent
            // @ts-expect-error private
            const onKeyExchangeMessage = jest.spyOn(publisher.publisher.keyExchange, 'onKeyExchangeMessage')

            // this should set up group key
            const published = await publishTestMessages(1)

            const received = await sub.collect(1)
            expect(onKeyExchangeMessage).toHaveBeenCalledTimes(1)
            await subscriber.destroy()

            const subscriber2 = createClient({
                id: 'subscriber2',
                auth: {
                    privateKey: subscriberPrivateKey
                }
            })

            const sub2 = await subscriber2.subscribe({
                stream: stream.id,
            })

            published.push(...await publishTestMessages(3))
            const received2 = await sub2.collect(3)
            expect(onKeyExchangeMessage).toHaveBeenCalledTimes(1)
            expect(received2).toEqual(published.slice(1))
            expect(received).toEqual(published.slice(0, 1))
        }, 2 * TIMEOUT)

        it('subscriber persists group key with resend last', async () => {
            // we want to check that subscriber can read a group key
            // persisted by another subscriber:
            // 1. create publisher and subscriber
            // 2. after subscriber gets first message
            // 3. disconnect both subscriber and publisher
            // 4. then create a new subscriber with same key as original subscriber
            // 5. and subscribe to same stream.
            // this should pick up group key persisted by first subscriber
            // publisher is disconnected, so can't ask for new group keys
            const sub = await subscriber.subscribe({
                stream: stream.id,
            })

            await stream.addToStorageNode(StorageNode.STREAMR_DOCKER_DEV)
            const published = await publishTestMessages(5, {
                waitForLast: true
            })

            const received = []
            for await (const m of sub) {
                received.push(m)
                if (received.length === 1) {
                    break
                }
            }
            await subscriber.destroy()
            await publisher.destroy()

            const subscriber2 = createClient({
                id: 'subscriber2',
                auth: {
                    privateKey: subscriberPrivateKey
                }
            })

            await subscriber2.connect()
            const sub2 = await subscriber2.resend({
                stream: stream.id,
                resend: {
                    last: 5
                }
            })

            const received2 = []
            for await (const m of sub2) {
                received2.push(m)
                if (received2.length === published.length) {
                    break
                }
            }
            expect(received2).toEqual(published)
            expect(received).toEqual(published.slice(0, 1))
        }, 2 * TIMEOUT)

        it('can run multiple publishers in parallel', async () => {
            const sub = await subscriber.subscribe({
                stream: stream.id,
            })

            // ensure publishers don't clobber each others data
            const publisher2 = createClient({
                id: 'publisher2',
                auth: {
                    privateKey: publisherPrivateKey,
                }
            })

            const publishTestMessages2 = getPublishTestStreamMessages(publisher2, stream)
            const MAX_MESSAGES = 16
            const [published1, published2] = await Promise.all([
                publishTestMessages(MAX_MESSAGES - 1),
                publishTestMessages2(MAX_MESSAGES), // use different lengths so we can differentiate who published what
            ])

            const received1 = []
            const received2 = []
            for await (const m of sub) {
                const content = m.getParsedContent()
                // 'n of MAX_MESSAGES' messages belong to publisher2
                // @ts-expect-error
                if (content.value.endsWith(`of ${MAX_MESSAGES}`)) {
                    received2.push(m)
                } else {
                    received1.push(m)
                }

                if (received1.length === published1.length && received2.length === published2.length) {
                    break
                }
            }

            expect(received1).toEqual(published1)
            expect(received2).toEqual(published2)
        }, 3 * TIMEOUT)

        describe('publisher does not complain about group key when many concurrent publishes', () => {
            const NUM_STREAMS = 20
            let streams: Stream[]

            beforeEach(async () => {
                publisherPrivateKey = fakePrivateKey()
                publisher = createClient({
                    id: 'publisher',
                    auth: {
                        privateKey: publisherPrivateKey,
                    },
                })

                streams = await Promise.all(Array(NUM_STREAMS).fill(true).map(async () => createTestStream(publisher, module)))
            }, 2 * TIMEOUT)

            afterEach(() => (
                publisher.destroy()
            ))

            test('works', async () => {
                const tasks = streams.map(async (s) => {
                    const publish = getPublishTestStreamMessages(publisher, s)
                    const published = await Promise.all([
                        publish(5),
                        publish(5),
                        publish(5),
                        publish(5),
                    ])
                    return published.flat()
                })
                await Promise.allSettled(tasks)
                const publishedPerStream = await Promise.all(tasks)
                expect(publishedPerStream.map((p) => p.length)).toEqual(Array(NUM_STREAMS).fill(20))
            }, 2 * TIMEOUT)
        })

        describe('publisher does not complain about group key when many concurrent publishes with storage', () => {
            const NUM_STREAMS = 20
            let streams: Stream[]

            beforeEach(async () => {
                publisherPrivateKey = fakePrivateKey()
                publisher = createClient({
                    id: 'publisher',
                    auth: {
                        privateKey: publisherPrivateKey,
                    },
                })

                streams = await Promise.all(Array(NUM_STREAMS).fill(true).map(async () => {
                    const s = await createTestStream(publisher, module)
                    await s.addToStorageNode(StorageNode.STREAMR_DOCKER_DEV)
                    return s
                }))
            }, 2 * TIMEOUT)

            afterEach(() => (
                publisher.destroy()
            ))

            test('works', async () => {
                const tasks = streams.map(async (s) => {
                    const publish = getPublishTestStreamMessages(publisher, s)
                    const published = await Promise.all([
                        publish(5),
                        publish(5),
                        publish(5),
                        publish(5),
                    ])
                    return published.flat()
                })
                await Promise.allSettled(tasks)
                const publishedPerStream = await Promise.all(tasks)
                expect(publishedPerStream.map((p) => p.length)).toEqual(Array(NUM_STREAMS).fill(20))
            }, 2 * TIMEOUT)
        })
    })

    describe('with requireEncryptedData = false', () => {
        const NUM_STREAMS = 20
        let streams: Stream[]

        beforeEach(async () => {
            publisherPrivateKey = fakePrivateKey()
            publisher = createClient({
                id: 'publisher',
                auth: {
                    privateKey: publisherPrivateKey,
                },
            })

            streams = await Promise.all(Array(NUM_STREAMS).fill(true).map(async () => {
                return createTestStream(publisher, module, {
                    requireEncryptedData: false,
                })
            }))
        }, 2 * TIMEOUT)

        afterEach(() => (
            publisher.destroy()
        ))

        test('publisher does not complain about group key when many concurrent publishes', async () => {
            const tasks = streams.map(async (stream) => {
                const publish = getPublishTestStreamMessages(publisher, stream)
                const published = await Promise.all([
                    publish(5),
                    publish(5),
                    publish(5),
                    publish(5),
                ])
                return published.flat()
            })

            await Promise.allSettled(tasks)
            const publishedPerStream = await Promise.all(tasks)
            expect(publishedPerStream.map((p) => p.length)).toEqual(Array(NUM_STREAMS).fill(20))
        }, 2 * TIMEOUT)
    })
})
