export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDagIntegrity(workflowGraph: any): DagValidationResult {
  const result: DagValidationResult = { valid: true, errors: [], warnings: [] };

  if (!workflowGraph || !Array.isArray(workflowGraph.nodes)) {
    result.errors.push("Invalid graph: missing or malformed 'nodes' array.");
    result.valid = false;
    return result;
  }

  const nodes = workflowGraph.nodes;
  const edges = Array.isArray(workflowGraph.edges) ? workflowGraph.edges : [];
  
  const nodeIds = new Set<string>();

  // 1. Validate Node uniqueness and minimum geometric fields
  for (const node of nodes) {
    if (!node.id) {
      result.errors.push(`A node is missing the required 'id' attribute.`);
      continue;
    }
    
    if (nodeIds.has(node.id)) {
      result.errors.push(`Duplicate node ID detected: ${node.id}`);
    }
    nodeIds.add(node.id);

    // Dify Vue Frontend relies on layout coords
    if (!node.position || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
       result.warnings.push(`Node '${node.id}' is missing valid layout coordinates (position.x/y). Dify might crash on render. Fixing silently.`);
       node.position = { x: 50, y: 50, ...node.position };
    }
    if (!node.width || !node.height) {
        node.width = node.width || 242;
        node.height = node.height || 100;
    }
    if (!node.data || typeof node.data.type !== 'string') {
       result.errors.push(`Node '${node.id}' is missing essential internal 'data.type' declaration.`);
    }
  }

  // 2. Validate Edge Reference Integrity (No Ghost Links)
  for (const edge of edges) {
    if (!edge.source || !edge.target) {
        result.errors.push(`Edge '${edge.id || 'unknown'}' is missing required source or target.`);
        continue;
    }
    if (!nodeIds.has(edge.source)) {
        result.errors.push(`DAG Reference Error: Edge '${edge.id}' references a non-existent source node '${edge.source}'. Frontend render will crash.`);
    }
    if (!nodeIds.has(edge.target)) {
        result.errors.push(`DAG Reference Error: Edge '${edge.id}' references a non-existent target node '${edge.target}'. Frontend render will crash.`);
    }
  }

  if (result.errors.length > 0) {
    result.valid = false;
  }

  return result;
}
