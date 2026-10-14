'use strict';
const p = require('./b-interface-protocol');
function literal(value) {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
}
function generate(config) {
  const soap = config && config.soap;
  if (!soap || !['1.1','1.2'].includes(soap.version) || typeof soap.namespace !== 'string' || !soap.namespace.length || soap.namespace.length > 200 ||
      !/^(https?:|urn:)/.test(soap.namespace) || /[\x00-\x1f\x7f\u2028\u2029]/.test(soap.namespace) ||
      ['method','parameter','result'].some(key => typeof soap[key] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(soap[key]))) throw new Error('请先保存有效的 SOAP 版本、命名空间、方法和参数配置');
  const uri = soap.version === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  const reason = 'Invalid or unsupported B-interface test request';
  const faultBody = soap.version === '1.2' ?
    '<s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">' + reason + '</s:Text></s:Reason>' :
    '<faultcode>s:Client</faultcode><faultstring>' + reason + '</faultstring>';
  const fault = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="' + uri + '"><s:Body><s:Fault>' + faultBody + '</s:Fault></s:Body></s:Envelope>';
  const marker = 'B_ACK_CONTENT_MARKER', wrapper = p.envelope(marker,soap,true).split(marker);
  const script = `// Paste into SC MockService -> ${soap.method} -> Response 1 -> Script.
// Replace the Response 1 XML body with the supplied response-body placeholder.
// Test mock: echoes request SUId; does not authenticate accounts or store alarms.
import com.eviware.soapui.support.XmlHolder
import javax.xml.parsers.DocumentBuilderFactory
import org.xml.sax.InputSource

def fault = ${literal(fault)}
requestContext.bAckEnvelope = fault
try {
    def raw = mockRequest.requestContent ?: ''
    if (raw.getBytes('UTF-8').length > 2097152 || raw =~ /(?i)<!DOCTYPE|<!ENTITY/) throw new IllegalArgumentException('XML rejected')
    def factory = DocumentBuilderFactory.newInstance()
    factory.namespaceAware = true
    factory.setFeature('http://apache.org/xml/features/disallow-doctype-decl', true)
    factory.setFeature('http://xml.org/sax/features/external-general-entities', false)
    factory.setFeature('http://xml.org/sax/features/external-parameter-entities', false)
    factory.setXIncludeAware(false)
    factory.setExpandEntityReferences(false)
    def root = factory.newDocumentBuilder().parse(new InputSource(new StringReader(raw))).documentElement
    def child = { parent, String name ->
        def matches = []
        if (parent != null) for (def n = parent.firstChild; n != null; n = n.nextSibling) if (n.nodeType == 1 && (n.localName ?: n.nodeName) == name) matches.add(n)
        matches.size() == 1 ? matches[0] : null
    }
    def body = child(root, 'Body')
    def operation = child(body, ${literal(soap.method)})
    if (root.localName != 'Envelope' || root.namespaceURI != ${literal(uri)} || body == null || body.namespaceURI != ${literal(uri)} || operation == null || operation.namespaceURI != ${literal(soap.namespace)}) throw new IllegalArgumentException('SOAP binding rejected')
    def parameter = child(operation, ${literal(soap.parameter)})
    def xml = parameter?.textContent ?: ''
    if (!xml || xml.getBytes('UTF-8').length > 2097152 || xml =~ /(?i)<!DOCTYPE|<!ENTITY/) throw new IllegalArgumentException('Business XML rejected')
    def message = new XmlHolder(xml)
    def name = (message.getNodeValue("/*[local-name()='Request']/*[local-name()='PK_Type']/*[local-name()='Name']/text()") ?: '').trim()
    def code = (message.getNodeValue("/*[local-name()='Request']/*[local-name()='PK_Type']/*[local-name()='Code']/text()") ?: '').trim()
    def suId = (message.getNodeValue("/*[local-name()='Request']/*[local-name()='Info']/*[local-name()='SUId']/text()") ?: '').trim()
    def supported = ['LOGIN': '101', 'LOGOUT': '103', 'SEND_ALARM': '603', 'SEND_HISALARM': '605']
    if (supported[name] != code || !suId.matches('[0-9A-Fa-f]{12}')) throw new IllegalArgumentException('Header rejected')
    def ackName = name + '_ACK'
    def ackCode = (Integer.parseInt(code) + 1).toString()
    def result = name == 'LOGIN' ? '<RightLevel>1</RightLevel>' : '<Result>1</Result>'
    def business = '<?xml version="1.0" encoding="UTF-8"?><Response><PK_Type><Name>' + ackName + '</Name><Code>' + ackCode + '</Code></PK_Type><Info><SUId>' + suId + '</SUId>' + result + '</Info></Response>'
    requestContext.bAckEnvelope = ${literal(wrapper[0] + '<![CDATA[')} + business + ${literal(']]>' + wrapper[1])}
    log.info('B-interface test ACK: ' + name + '/' + code + ' -> ' + ackName + '/' + ackCode)
} catch (Exception ignored) {
    requestContext.bAckEnvelope = fault
    log.warn('B-interface test request rejected; no success ACK generated')
}
`;
  return { script, responseBody: '${bAckEnvelope}' };
}
module.exports = { generate };
