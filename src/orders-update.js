import Ajv from 'ajv'
import Promise from 'bluebird'
import { SphereClient } from 'sphere-node-sdk'

import orderSchema from './order-schema'
import buildOrderActions from './build-order-actions'

export default class OrdersUpdate {

  constructor (apiClientConfig, logger) {
    this.client = new SphereClient(apiClientConfig)

    this.logger = logger || {
      error: process.stderr.write.bind(process.stderr),
      warn: process.stderr.write.bind(process.stderr),
      info: process.stdout.write.bind(process.stdout),
      verbose: process.stdout.write.bind(process.stdout),
    }

    this.summary = {
      errors: [],
      inserted: [],
      successfullImports: 0,
    }
  }

  // Return JSON string of this.summary object
  // summaryReport :: () -> String
  summaryReport () {
    return JSON.stringify(this.summary, null, 2)
  }

  // Check if order data has required fields and correct types
  // validateOrderData :: Object -> Promise -> Object
  // eslint-disable-next-line class-methods-use-this
  validateOrderData (order) {
    const ajv = new Ajv({ removeAdditional: true })
    const ajvOrder = ajv.compile(orderSchema)

    if (ajvOrder(order))
      return Promise.resolve(order)

    return Promise.reject(ajvOrder.errors)
  }

  // Wrapper function that validates and updates
  // processOrder :: Object -> () -> Object
  processOrder (order) {
    return this.validateOrderData(order)
      .then(this.updateOrder.bind(this))
      .then((result) => {
        this.summary.inserted.push(order.orderNumber)
        this.summary.successfullImports += 1

        return result.body
      })
      .catch((error) => {
        this.summary.errors.push({ order, error })
      })
  }

  // Update order calling the API
  // updateOrder :: Object -> () -> Object
  updateOrder (order) {
    return this.client.orders
      .where(`orderNumber="${order.orderNumber}"`)
      .fetch()
      .then(({ body: { total, results: existingOrders } }) => {
        if (total === 1) {
          const existingOrder = existingOrders[0]
          const actions = this.buildUpdateActions(order)

          // Do not call the API when there are no changes
          if (actions.length > 0)
            return this.client.orders
              .byId(existingOrder.id)
              .update({
                version: existingOrder.version,
                actions,
              })

          return order
        }

        return Promise.reject(Object.assign(
          new Error(`Order with orderNumber ${order.orderNumber} not found.`),
          { code: 'ENOENT' },
        ))
      })
  }

  // eslint-disable-next-line class-methods-use-this
  // Create API action objects based on the order data
  // buildUpdateActions :: Object -> [Object]
  buildUpdateActions (order) {
    const actions = []

    Object.keys(order).forEach((field) => {
      if (typeof buildOrderActions[field] === 'function')
        actions.push(...buildOrderActions[field](order))
    })

    this.logger.verbose(`Build update actions: ${actions}`)
    return actions
  }

  // Wrapper function for compatibility with the CLI
  // processStream :: ([Object], Function) -> ()
  processStream (orders, next) {
    this.logger.info('Starting order processing')
    // process batch
    return Promise.map(
      orders, order => this.processOrder(order),
    ).then(() => {
      // call next for next batch
      next()
    })
    // errors get catched in the node-cli which also calls for the next chunk
    // if an error occured in this chunk
  }
}
