import ControlMessage from '../ControlMessage'

import ResendResponseResending from './ResendResponseResending'

import { Serializer } from '../../../Serializer'

const VERSION = 1

export default class ResendResponseResendingSerializerV1 extends Serializer<ResendResponseResending> {
    toArray(resendResponseResending: ResendResponseResending): any[] {
        return [
            VERSION,
            ControlMessage.TYPES.ResendResponseResending,
            resendResponseResending.streamId,
            resendResponseResending.streamPartition,
            resendResponseResending.requestId,
        ]
    }

    fromArray(arr: any[]): ResendResponseResending {
        const [
            version,
            type, // eslint-disable-line @typescript-eslint/no-unused-vars
            streamId,
            streamPartition,
            requestId,
        ] = arr

        return new ResendResponseResending({
            version, requestId, streamId, streamPartition
        })
    }
}

ControlMessage.registerSerializer(VERSION, ControlMessage.TYPES.ResendResponseResending, new ResendResponseResendingSerializerV1())
