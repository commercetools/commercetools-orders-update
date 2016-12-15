import Ajv from 'ajv'
import Promise from 'bluebird'
import { SphereClient } from 'sphere-node-sdk'

import orderSchema from './order-schema'

const ajv = new Ajv({ removeAdditional: true })

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
    const validatedOrderData = ajv.compile(orderSchema)(order)

    if (validatedOrderData)
      return Promise.resolve(order)

    return Promise.reject(`Validation error: ${validatedOrderData.errors}`)
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

    if (order.lineItems)
      order.lineItems.forEach((lineItem) => {
        if (lineItem.state)
          lineItem.state.forEach((state) => {
            if (state.fromState && state.toState) {
              const action = {
                action: 'transitionLineItemState',
                lineItemId: lineItem.id,
                quantity: state.quantity,
                fromState: state.fromState,
                toState: state.toState,
              }

              // Check for optional fields
              if (state.actualTransitionDate)
                action.actualTransitionDate = state.actualTransitionDate

              actions.push(action)
            }
          })
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
