"""Bounded LSB bit windows for the measured replicated struct-array framing."""


class Bits:
    def __init__(self, raw, count):
        if not isinstance(raw, (bytes, bytearray)) or type(count) is not int or not 0<=count<=len(raw)*8:
            raise ValueError('Invalid bit window')
        self.raw,self.count,self.pos=raw,count,0

    def read(self,count):
        if count<0 or self.pos+count>self.count:
            raise ValueError('Truncated bit window')
        value=0
        for i in range(count):
            value|=((self.raw[self.pos//8]>>(self.pos%8))&1)<<i
            self.pos+=1
        return value

    def packed(self):
        value=0
        for i in range(5):
            byte=self.read(8)
            value|=(byte>>1)<<(i*7)
            if not byte&1:
                if value>0xffffffff or i and byte==0:
                    raise ValueError('Noncanonical packed integer')
                return value
        raise ValueError('Packed integer overflow')

    def window(self,count):
        value=self.read(count)
        return Bits(value.to_bytes((count+7)//8,'little'),count)


def array_delta(raw,bit_count):
    bits=Bits(raw,bit_count)
    size=bits.packed()
    if size>4096:raise ValueError('Array length exceeds bound')
    changed={}
    while True:
        index=bits.packed()
        if not index:break
        index-=1
        if index>=size or index in changed:raise ValueError('Invalid or repeated array index')
        fields={}
        while True:
            handle=bits.packed()
            if not handle:break
            handle-=1
            if handle in fields or len(fields)>=128:raise ValueError('Invalid or repeated member handle')
            fields[handle]=bits.window(bits.packed())
        changed[index]=fields
    if bits.pos!=bits.count:raise ValueError('Unconsumed array bits')
    return size,changed
