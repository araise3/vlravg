// The dedicated Henrik key also authenticates workflow requests to our proxy.
// Web Crypto verification compares secrets without a string timing side channel.
export async function workflowAuthorized(request, expected, header='X-Workflow-Key') {
  const supplied=request.headers.get(header);
  if(!supplied||!expected)return false;
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(expected),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const signature=await crypto.subtle.sign('HMAC',key,encoder.encode(expected));
  return crypto.subtle.verify('HMAC',key,signature,encoder.encode(supplied));
}
