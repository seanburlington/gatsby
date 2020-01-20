// @flow
const { default: sift } = require(`sift`)
const _ = require(`lodash`)
const prepareRegex = require(`../utils/prepare-regex`)
const { makeRe } = require(`micromatch`)
const { getValueAt } = require(`../utils/get-value-at`)
const {
  toDottedFields,
  objectToDottedField,
  liftResolvedFields,
} = require(`../db/common/query`)
const {
  ensureIndexByTypedChain,
  getNodesByTypedChain,
  getResolvedNodesCache,
  addResolvedNodes,
  getNode,
} = require(`./nodes`)

/////////////////////////////////////////////////////////////////////
// Parse filter
/////////////////////////////////////////////////////////////////////

const prepareQueryArgs = (filterFields = {}) =>
  Object.keys(filterFields).reduce((acc, key) => {
    const value = filterFields[key]
    if (_.isPlainObject(value)) {
      acc[key === `elemMatch` ? `$elemMatch` : key] = prepareQueryArgs(value)
    } else {
      switch (key) {
        case `regex`:
          acc[`$regex`] = prepareRegex(value)
          break
        case `glob`:
          acc[`$regex`] = makeRe(value)
          break
        default:
          acc[`$${key}`] = value
      }
    }
    return acc
  }, {})

const getFilters = filters =>
  Object.keys(filters).reduce(
    (acc, key) => acc.push({ [key]: filters[key] }) && acc,
    []
  )

/////////////////////////////////////////////////////////////////////
// Run Sift
/////////////////////////////////////////////////////////////////////

function isEqId(siftArgs) {
  // The `id` of each node is invariably unique. So if a query is doing id $eq(string) it can find only one node tops
  return (
    siftArgs.length > 0 &&
    siftArgs[0].id &&
    Object.keys(siftArgs[0].id).length === 1 &&
    Object.keys(siftArgs[0].id)[0] === `$eq`
  )
}

function handleFirst(siftArgs, nodes) {
  if (nodes.length === 0) {
    return []
  }

  const index = _.isEmpty(siftArgs)
    ? 0
    : nodes.findIndex(
        sift({
          $and: siftArgs,
        })
      )

  if (index !== -1) {
    return [nodes[index]]
  } else {
    return []
  }
}

function handleMany(siftArgs, nodes, sort, resolvedFields) {
  let result = _.isEmpty(siftArgs)
    ? nodes
    : nodes.filter(
        sift({
          $and: siftArgs,
        })
      )

  if (!result || !result.length) return null

  // Sort results.
  if (sort && result.length > 1) {
    // create functions that return the item to compare on
    const dottedFields = objectToDottedField(resolvedFields)
    const dottedFieldKeys = Object.keys(dottedFields)
    const sortFields = sort.fields
      .map(field => {
        if (
          dottedFields[field] ||
          dottedFieldKeys.some(key => field.startsWith(key))
        ) {
          return `__gatsby_resolved.${field}`
        } else {
          return field
        }
      })
      .map(field => v => getValueAt(v, field))
    const sortOrder = sort.order.map(order => order.toLowerCase())

    result = _.orderBy(result, sortFields, sortOrder)
  }
  return result
}

/**
 * Filters a list of nodes using mongodb-like syntax.
 *
 * @param args raw graphql query filter as an object
 * @param nodes The nodes array to run sift over (Optional
 *   will load itself if not present)
 * @param type gqlType. Created in build-node-types
 * @param firstOnly true if you want to return only the first result
 *   found. This will return a collection of size 1. Not a single
 *   element
 * @returns Collection of results. Collection will be limited to size
 *   if `firstOnly` is true
 */
const runSift = (args: Object) => {
  const { nodeTypeNames, firstOnly = false } = args

  const filter = args.queryArgs?.filter
  if (filter) {
    // This can be any string of {a: {b: {c: {eq: "x"}}}} and we want to confirm there is exactly one leaf in this
    // structure and that this leaf is `eq`. The actual names are irrelevant, they are props on each node.

    // TODO: This seems to perform okay but is it faster to just JSON.stringify the filter and use regexes to get the chain...?
    let chain = []
    let props = Object.getOwnPropertyNames(filter)
    let obj = filter
    while (props?.length === 1 && props[0] !== `eq`) {
      chain.push(props[0])
      obj = obj[props[0]]
      if (obj) {
        props = Object.getOwnPropertyNames(obj)
      } else {
        props = []
      }
    }

    // Now either we reached an `eq` (still need to confirm that this is a leaf node), or the current
    // object has multiple props and we must bail because we currently don't support that (too complex).
    let targetValue = obj?.[props[0]]
    if (
      props.length === 1 &&
      (typeof targetValue === `string` ||
        typeof targetValue === `boolean` ||
        typeof targetValue === `number`)
    ) {
      // `chain` should now be: `filter = {this: {is: {the: {chain: {eq: "foo"}}}}}` -> `['this', 'is', 'the', 'chain']`

      // Extra shortcut for `id`, which we internally index by anyways, so no need to setup anything else
      if (chain.join(`,`) === `id`) {
        const node = getNode(targetValue)
        if (node && nodeTypeNames.includes(node.internal.type)) {
          const resolvedNodesCache = getResolvedNodesCache()
          const resolvedNodes = resolvedNodesCache?.get(node.internal.type)
          if (resolvedNodes) {
            node.__gatsby_resolved = resolvedNodes.get(node.id)
          }
          return [node]
        }
        if (firstOnly) {
          return []
        }
        return null
      }

      ensureIndexByTypedChain(chain, nodeTypeNames)

      const nodesByKeyValue = getNodesByTypedChain(
        chain,
        targetValue,
        nodeTypeNames
      )

      if (nodesByKeyValue?.size > 0) {
        return [...nodesByKeyValue]
      }
      // Not sure if we can just return `undefined` on a miss here
    }
  }

  let nodes = []

  nodeTypeNames.forEach(typeName => addResolvedNodes(typeName, nodes))

  return runSiftOnNodes(nodes, args, getNode)
}

exports.runSift = runSift

const runSiftOnNodes = (nodes, args, getNode) => {
  const {
    queryArgs = { filter: {}, sort: {} },
    firstOnly = false,
    resolvedFields = {},
    nodeTypeNames,
  } = args

  let siftFilter = getFilters(
    liftResolvedFields(
      toDottedFields(prepareQueryArgs(queryArgs.filter)),
      resolvedFields
    )
  )

  // If the the query for single node only has a filter for an "id"
  // using "eq" operator, then we'll just grab that ID and return it.
  if (isEqId(siftFilter)) {
    const node = getNode(siftFilter[0].id.$eq)

    if (
      !node ||
      (node.internal && !nodeTypeNames.includes(node.internal.type))
    ) {
      if (firstOnly) return []
      return null
    }

    return [node]
  }

  if (firstOnly) {
    return handleFirst(siftFilter, nodes)
  } else {
    return handleMany(siftFilter, nodes, queryArgs.sort, resolvedFields)
  }
}

exports.runSiftOnNodes = runSiftOnNodes
