'use strict';
const { esc } = require('./b-interface-protocol');

// Keep the WSDL wrapper identical to envelope()/unwrap(); business XML is a string.
function generate(config, kind) {
  if (kind !== 'su' && kind !== 'sc') throw new Error('WSDL 类型仅支持 su 或 sc');
  const name = kind === 'su' ? 'SUService' : 'SCService';
  let endpoint;
  if (kind === 'su') {
    if (!config.suIp) throw new Error('请先填写并保存 SU 内网 IPv4 地址，再下载 SU WSDL');
    endpoint = 'http://' + config.suIp + ':' + config.port + config.servicePath;
  } else {
    endpoint = config.scUrls[0];
    if (!endpoint) throw new Error('请先填写并保存 SC 注册服务 URL，再下载 SC WSDL');
  }
  const s = config.soap;
  const namespace = esc(s.namespace), method = esc(s.method);
  const binding = s.version === '1.2' ? 'http://schemas.xmlsoap.org/wsdl/soap12/' : 'http://schemas.xmlsoap.org/wsdl/soap/';
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="${binding}" xmlns:tns="${namespace}" targetNamespace="${namespace}" name="${name}">
  <wsdl:documentation>按本软件已保存的 SOAP 配置生成的联调 WSDL。业务 XML 通过字符串参数传输；正式对接须核对上级平台绑定。</wsdl:documentation>
  <wsdl:types>
    <xsd:schema targetNamespace="${namespace}" elementFormDefault="unqualified">
      <xsd:element name="${method}"><xsd:complexType><xsd:sequence><xsd:element name="${esc(s.parameter)}" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="${method}Response"><xsd:complexType><xsd:sequence><xsd:element name="${esc(s.result)}" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
    </xsd:schema>
  </wsdl:types>
  <wsdl:message name="InvokeRequest"><wsdl:part name="parameters" element="tns:${method}"/></wsdl:message>
  <wsdl:message name="InvokeResponse"><wsdl:part name="parameters" element="tns:${method}Response"/></wsdl:message>
  <wsdl:portType name="${name}PortType">
    <wsdl:operation name="${method}"><wsdl:input message="tns:InvokeRequest"/><wsdl:output message="tns:InvokeResponse"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="${name}SoapBinding" type="tns:${name}PortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="${method}">
      <soap:operation soapAction="${esc(s.action)}"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="${name}"><wsdl:port name="${name}Port" binding="tns:${name}SoapBinding"><soap:address location="${esc(endpoint)}"/></wsdl:port></wsdl:service>
</wsdl:definitions>\n`;
}
module.exports = { generate };
