import { fromPromise, of } from 'hyper-async'
import { assoc } from 'ramda'

import { deployMonitorSchema, signerSchema } from '../../dal.js'

/**
 * @typedef Tag3
 * @property {string} name
 * @property {any} value
 *
 * @typedef Context3
 * @property {string} id - the transaction id to be verified
 * @property {any} input
 * @property {any} wallet
 * @property {Tag3[]} tags
 *
 * @typedef Env6
 * @property {any} mu
 */

/**
 * @callback BuildTx
 * @param {Context3} ctx
 * @returns {Async<Context3>}
 *
 * @param {Env6} env
 * @returns {BuildTx}
 */
export function uploadUnmonitorWith (env) {
  const deployUnmonitor = deployMonitorSchema.implement(env.deployUnmonitor)

  return (ctx) => {
    return of(ctx)
      .chain(fromPromise(({ id, signer }) =>
        deployUnmonitor({
          processId: id,
          signer: signerSchema.implement(signer || env.signer),
          /**
           * No tags or data can be provided right now,
           *
           * so just set data to single space and set tags to an empty array
           */
          data: ' ',
          tags: []
        })
      ))
      .map(res => assoc('monitorId', res.messageId, ctx))
  }
}
